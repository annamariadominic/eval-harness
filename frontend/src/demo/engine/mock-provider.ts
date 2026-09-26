/**
 * Port of `app/providers/mock.py`: the deterministic offline provider.
 *
 * Every output is a pure function of (model, messages, settings), and every "random" choice is
 * derived from a SHA-256 of the inputs, so this produces exactly what the Python mock produces.
 * Behaviour is documented in the Python module; this file mirrors it function by function.
 */

import type { GenerationResult, Message, ModelConfig, ModelProvider, Sleep } from "./providers";
import { ProviderError, realSleep } from "./providers";
import { pyLen, pyRepr, pyRound, pySlice, pySplit, pyStrip } from "./py";
import { dumps, PyFloat } from "./pyjson";
import { sha256Hex } from "./sha256";

const MODEL_SKILL: Record<string, number> = { "mock-small": 0.7, "mock-large": 0.9 };
const BASE_LATENCY_MS: Record<string, number> = { "mock-small": 180.0, "mock-large": 420.0 };
const DEFAULT_SKILL = 0.8;
const DEFAULT_LATENCY_MS = 250.0;

const STOPWORDS = new Set(
  `a an the of in on at to for from by with and or but is are was were be been being it its
    this that these those as what which who whom how when where why did does do has have had
    their there they them than then so such not no into over under about per via our your you
    i we he she his her will would can could should may might also based provided context
    according answer question passage`
    .split(/\s+/)
    .filter(Boolean),
);

const EMBELLISHMENTS = [
  "This is broadly in line with wider industry expectations.",
  "Analysts generally view this as a strong signal for the coming year.",
  "The figure is likely to keep growing as the market matures.",
];

// Python's `\w` and `\b` are Unicode-aware; JavaScript's are ASCII-only, so spell them out.
const W = String.raw`[\p{L}\p{N}_]`;
const B = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const MONEY_RE = new RegExp(
  String.raw`(?:\$|USD\s?)\s?(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|mn|m|thousand|k)?${B}`,
  "giu",
);
const COMPANY_RE = new RegExp(
  String.raw`${B}([A-Z][\p{L}\p{N}_&'\-]*(?:[ \t]+[A-Z][\p{L}\p{N}_&'\-]*){0,3}[ \t]+` +
    String.raw`(?:Inc|Corp|Corporation|Ltd|LLC|Group|Holdings|Industries|Labs|Systems|Technologies|GmbH|PLC))${B}\.?`,
  "u",
);
const YEAR_RE = new RegExp(String.raw`${B}(?:fiscal(?:\s+year)?|FY)\s*'?(\d{4}|\d{2})${B}`, "iu");
const PLAIN_YEAR_RE = new RegExp(String.raw`${B}(20\d{2})${B}`, "u");
const REVENUE_WORDS = /revenue|sales|turnover|top ?-?line/gi;
const CLAUSE_BREAK_RE = /[;()\n]|\.\s/g;
const MULTIPLIERS: Record<string, number> = {
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  million: 1e6,
  mn: 1e6,
  m: 1e6,
  thousand: 1e3,
  k: 1e3,
};

export class MockProvider implements ModelProvider {
  readonly name = "mock";
  // Attempt counters per request fingerprint let simulated transient failures clear on retry.
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly latencyScale = 1.0,
    private readonly sleep: Sleep = realSleep,
  ) {}

  async generate(messages: Message[], config: ModelConfig): Promise<GenerationResult> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const user = messages
      .filter((m) => m.role !== "system")
      .map((m) => m.content)
      .join("\n\n");
    const schemaName = config.schema_name ?? "response";
    const settings = config.settings ?? {};
    const fingerprint = digest(config.model, schemaName, system, user);
    const attempt = (this.attempts.get(fingerprint) ?? 0) + 1;
    this.attempts.set(fingerprint, attempt);

    const scale = Number(settings.mock_latency_scale ?? this.latencyScale);
    const failureRate = Number(settings.mock_failure_rate ?? 0.0);
    if (failureRate > 0 && roll(fingerprint, String(attempt)) < failureRate) {
      await this.sleep(0.05 * scale);
      throw new ProviderError(
        "Simulated transient upstream error (503 Service Unavailable)",
        "server_error",
        503,
      );
    }

    let output: string;
    if (schemaName === "judgement") output = judge(user);
    else if (config.response_schema != null || system.toLowerCase().includes("json")) {
      output = extract(system, user, config);
    } else output = answer(system, user, config.model);

    const inputTokens = estimateTokens(system + user);
    const outputTokens = estimateTokens(output);
    const latencyMs = pyRound(
      (BASE_LATENCY_MS[config.model] ?? DEFAULT_LATENCY_MS) +
        0.8 * outputTokens +
        150 * roll(fingerprint, "latency"),
      1,
    );
    if (scale > 0) await this.sleep((latencyMs * scale) / 1000);
    return {
      output,
      latency_ms: latencyMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      model: config.model,
      provider: this.name,
      finish_reason: "stop",
    };
  }
}

// --- question answering ----------------------------------------------------------------------

function maxBy<T>(items: T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = -Infinity;
  for (const item of items) {
    const k = key(item);
    if (best === undefined || k > bestKey) {
      best = item;
      bestKey = k;
    }
  }
  return best;
}

function overlap(a: Set<string>, b: string[]): number {
  return new Set(b.filter((t) => a.has(t))).size;
}

function answer(system: string, user: string, model: string): string {
  const instructions = system.toLowerCase();
  const questionMatch = /question:\s*(.+)/i.exec(user);
  const question = questionMatch ? pyStrip(questionMatch[1]) : pyStrip(user).split("\n")[0];
  const found = passages(user);
  if (found.length === 0) return "I could not find any context to answer from.";

  const qTerms = new Set(contentTerms(question));
  const ranked = [...found].sort(
    (p, q) =>
      overlap(qTerms, contentTerms(q[1])) - overlap(qTerms, contentTerms(p[1])) ||
      Number(p[0]) - Number(q[0]),
  );
  const skill = MODEL_SKILL[model] ?? DEFAULT_SKILL;
  const distracted = ranked.length > 1 && roll(model, system, question) > skill;
  const [number, text] = distracted ? ranked[1] : ranked[0];
  const sentence = (
    maxBy(sentences(text), (s) => overlap(qTerms, contentTerms(s))) ?? text
  ).replace(/\.+$/, "");

  const concise = instructions.includes("concise") || instructions.includes("one sentence");
  const grounded = instructions.includes("only") && instructions.includes("context");
  let result = concise ? sentence : `According to the provided context, ${sentence}`;
  if (instructions.includes("cite") || instructions.includes("citation")) result += ` [${number}]`;
  result += ".";
  if (!grounded && roll(model, question, "embellish") < 0.55) {
    result += " " + EMBELLISHMENTS[Math.floor(roll(question, "which") * EMBELLISHMENTS.length)];
  }
  return result;
}

function passages(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [, n, body] of text.matchAll(/\[(\d+)\]\s*([\s\S]+?)(?=\s*\[\d+\]|$)/g)) {
    if (pyStrip(body)) out.push([n, pySplit(body).join(" ")]);
  }
  return out;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => pyStrip(s))
    .filter(Boolean);
}

// --- structured extraction -------------------------------------------------------------------

function extract(system: string, user: string, config: ModelConfig): string {
  const instructions = system.toLowerCase();
  const skill = MODEL_SKILL[config.model] ?? DEFAULT_SKILL;
  const distracted = roll(config.model, system, pySlice(user, 0, 400)) > skill;
  const structured = config.response_schema != null;

  const record: Record<string, unknown> = {};
  const company = COMPANY_RE.exec(user);
  if (company) record.company = pyStrip(company[1]);

  const revenue = findRevenue(user, distracted);
  if (revenue !== null) {
    const [amount, raw] = revenue;
    const wantsNumber =
      structured ||
      ["integer", "full number", "whole number"].some((phrase) => instructions.includes(phrase));
    const unitSlip = !wantsNumber && roll(config.model, user, "units") > skill - 0.1;
    record.revenue = unitSlip ? raw : amount;
  }

  const year = findYear(user);
  if (year !== null) record.year = year;

  const body = dumps(record);
  const rawOnly = ["only json", "only the json", "raw json", "no prose", "no markdown"].some(
    (phrase) => instructions.includes(phrase),
  );
  if (!structured && !rawOnly && roll(config.model, user, "fence") < 0.5) {
    return `Here is the extracted data:\n\`\`\`json\n${dumps(record, { indent: 2 })}\n\`\`\``;
  }
  return body;
}

function findRevenue(text: string, distracted: boolean): [number, string] | null {
  // Prefer an amount in the same clause as a revenue keyword; a distracted model just takes the
  // first amount it sees.
  const matches = Array.from(text.matchAll(MONEY_RE));
  if (matches.length === 0) return null;
  let chosen = matches[0];
  if (!distracted) {
    const bounds = [
      0,
      ...Array.from(text.matchAll(CLAUSE_BREAK_RE), (m) => m.index + m[0].length),
      text.length,
    ];
    for (const keyword of text.matchAll(REVENUE_WORDS)) {
      const start = keyword.index;
      const lo = Math.max(...bounds.filter((b) => b <= start));
      const hi = Math.min(...bounds.filter((b) => b > start));
      const inClause = matches.filter((m) => lo <= m.index && m.index < hi);
      if (inClause.length) {
        const after = inClause.filter((m) => m.index >= start);
        chosen = (after.length ? after : inClause)[0];
        break;
      }
    }
  }
  const number = Number(chosen[1].replaceAll(",", ""));
  const unit = (chosen[2] ?? "").toLowerCase();
  return [pyRound(number * (MULTIPLIERS[unit] ?? 1)), pyStrip(chosen[0])];
}

function findYear(text: string): number | null {
  const fiscal = YEAR_RE.exec(text);
  if (fiscal) {
    const value = fiscal[1];
    return value.length === 4 ? Number(value) : 2000 + Number(value);
  }
  const plain = PLAIN_YEAR_RE.exec(text);
  return plain ? Number(plain[1]) : null;
}

// --- judging ---------------------------------------------------------------------------------

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function judge(prompt: string): string {
  const response = section(prompt, "response");
  const reference = section(prompt, "reference");
  const source = section(prompt, "input");
  const criteria = section(prompt, "criteria").toLowerCase();
  let low = 0.0;
  let high = 1.0;
  const range = /score from (-?\d+(?:\.\d+)?) to (-?\d+(?:\.\d+)?)/.exec(prompt);
  if (range) {
    low = Number(range[1]);
    high = Number(range[2]);
  }

  const grounding = ["faithful", "grounded", "supported", "hallucinat"].some((w) =>
    criteria.includes(w),
  );
  const responseTerms = contentTerms(response);
  let fraction: number;
  let reason: string;
  if (grounding || !reference) {
    const allowed = new Set(contentTerms(source));
    const terms = unique(responseTerms);
    const unsupported = terms.filter((t) => !allowed.has(t));
    fraction = terms.length === 0 ? 1.0 : 1 - unsupported.length / terms.length;
    if (unsupported.length === 0) {
      reason = "Every claim in the response is supported by the provided input.";
    } else {
      const examples = unsupported
        .slice(0, 4)
        .map((t) => `'${t}'`)
        .join(", ");
      reason =
        `${unsupported.length} of ${terms.length} content terms are not supported by the ` +
        `input (e.g. ${examples}), indicating claims beyond the source material.`;
    }
  } else {
    const keyTerms = unique(contentTerms(reference));
    const present = new Set(responseTerms);
    const missing = keyTerms.filter((t) => !present.has(t));
    fraction = keyTerms.length === 0 ? 1.0 : 1 - missing.length / keyTerms.length;
    if (missing.length === 0) {
      reason = "The response contains every key fact from the reference answer.";
    } else {
      reason =
        `The response covers ${keyTerms.length - missing.length} of ${keyTerms.length} key ` +
        `facts from the reference; missing: ${missing.slice(0, 4).map(pyRepr).join(", ")}.`;
    }
  }

  const score = low + fraction * (high - low);
  // Python's round(x) returns an int, round(x, 3) keeps a float: they print differently.
  const printed = high - low >= 2 ? pyRound(score) : new PyFloat(pyRound(score, 3));
  return dumps({ reason, score: printed });
}

function section(text: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(text);
  return match ? match[1] : "";
}

// --- shared helpers --------------------------------------------------------------------------

const UNITS: Record<string, string> = { bn: "billion", b: "billion", m: "million", k: "thousand" };

function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start++;
  while (end > start && chars.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

export function contentTerms(text: string): string[] {
  const terms: string[] = [];
  for (const [raw] of text.matchAll(/[A-Za-z0-9$][A-Za-z0-9.,$%'-]*/g)) {
    const token = stripChars(raw.toLowerCase(), ".,'").replace(/^\$+/, "").replaceAll(",", "");
    const withUnit = /^(\d+(?:\.\d+)?)(bn|b|m|k)$/.exec(token);
    if (withUnit) {
      terms.push(withUnit[1], UNITS[withUnit[2]]);
      continue;
    }
    if (token && !STOPWORDS.has(token) && !/^\[?\d\]?$/.test(token)) terms.push(stem(token));
  }
  return terms;
}

/** Crude suffix stripping so "opened"/"open" and "vessels"/"vessel" line up. */
function stem(token: string): string {
  if (/^\p{L}+$/u.test(token) && pyLen(token) > 4) {
    for (const suffix of ["ing", "ed", "es", "s"]) {
      if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
        return token.slice(0, -suffix.length);
      }
    }
  }
  return token;
}

function estimateTokens(text: string): number {
  return Math.max(1, pyRound(pyLen(text) / 4));
}

function digest(...parts: string[]): string {
  return sha256Hex(parts.join("\x1f"));
}

/** Deterministic pseudo-random number in [0, 1) derived from the inputs. */
export function roll(...parts: string[]): number {
  return parseInt(digest(...parts).slice(0, 8), 16) / 0x1_0000_0000;
}
