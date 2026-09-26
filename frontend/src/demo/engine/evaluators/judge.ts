/** Port of `app/evaluators/judge.py`: LLM-as-a-judge with a user-defined rubric. */

import type { Message, ModelConfig } from "../providers";
import { isDict, pyFloatRepr, pyLen, pySlice, pyStrip } from "../py";
import {
  EvaluatorError,
  type EvaluationSample,
  type Evaluator,
  type EvaluatorOutcome,
  type ModelCaller,
} from "./base";
import { JsonParseError, parseJsonOutput, toText } from "./output";

export const JUDGE_SCHEMA_NAME = "judgement";
export const JUDGE_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      description: "Concise justification for the score, citing specifics.",
    },
    score: { type: "number" },
  },
  required: ["reason", "score"],
  additionalProperties: false,
};

export const JUDGE_SYSTEM_PROMPT =
  "You are a rigorous, impartial evaluator of AI-generated responses. Judge only against the " +
  "stated criteria. Explain your reasoning briefly and concretely before settling on a score. " +
  'Respond with a JSON object of the form {"reason": string, "score": number}.';

export type JudgeConfig = {
  provider: string;
  model: string;
  criteria: string;
  score_min: number;
  score_max: number;
  pass_threshold: number;
  include_input: boolean;
  include_expected: boolean;
  temperature: number | null;
  max_tokens: number;
};

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
}

export function buildJudgePrompt(config: JudgeConfig, sample: EvaluationSample): string {
  const sections = [
    "Evaluate the response below against the criteria.",
    `<criteria>\n${pyStrip(config.criteria)}\n</criteria>`,
  ];
  if (config.include_input) sections.push(`<input>\n${toText(sample.input)}\n</input>`);
  if (config.include_expected && sample.expected !== null && sample.expected !== undefined) {
    sections.push(`<reference>\n${toText(sample.expected)}\n</reference>`);
  }
  sections.push(`<response>\n${sample.output}\n</response>`);
  const low = fmt(config.score_min);
  const high = fmt(config.score_max);
  sections.push(
    `Give a score from ${low} to ${high}, where ${low} means the response completely fails ` +
      `the criteria and ${high} means it fully satisfies them.`,
  );
  return sections.join("\n\n");
}

const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** `JudgeVerdict.model_validate`: a dict with a non-empty `reason` and a numeric `score`. */
function asVerdict(data: unknown): { reason: string; score: number } | null {
  if (!isDict(data)) return null;
  const { reason, score } = data;
  if (typeof reason !== "string" || pyLen(reason) < 1) return null;
  if (typeof score === "number") return { reason, score };
  if (typeof score === "boolean") return { reason, score: Number(score) };
  if (typeof score === "string" && NUMERIC_RE.test(pyStrip(score))) {
    return { reason, score: Number(pyStrip(score)) };
  }
  return null;
}

export function parseVerdict(text: string): { reason: string; score: number } {
  let verdict: { reason: string; score: number } | null = null;
  try {
    verdict = asVerdict(parseJsonOutput(text, true));
  } catch (error) {
    if (!(error instanceof JsonParseError)) throw error;
  }
  if (verdict === null) {
    const preview = pyLen(text) <= 200 ? text : pySlice(text, 0, 200) + "…";
    throw new EvaluatorError(`Judge response did not match the expected schema: ${preview}`);
  }
  return verdict;
}

export class LLMJudgeEvaluator implements Evaluator {
  constructor(
    private readonly config: JudgeConfig,
    private readonly callModel: ModelCaller,
  ) {}

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    const messages: Message[] = [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: buildJudgePrompt(this.config, sample) },
    ];
    const modelConfig: ModelConfig = {
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.max_tokens,
      response_schema: JUDGE_RESPONSE_SCHEMA,
      schema_name: JUDGE_SCHEMA_NAME,
      settings: {},
    };
    const call = await this.callModel(this.config.provider, messages, modelConfig);
    const verdict = parseVerdict(call.result.output);

    const low = this.config.score_min;
    const high = this.config.score_max;
    if (!(low <= verdict.score && verdict.score <= high)) {
      throw new EvaluatorError(
        `Judge returned score ${pyFloatRepr(verdict.score)}, outside the range ${fmt(low)}-${fmt(high)}`,
      );
    }
    const normalised = (verdict.score - low) / (high - low);
    return {
      score: normalised,
      passed: normalised >= this.config.pass_threshold,
      reason: verdict.reason,
      details: {
        raw_score: verdict.score,
        score_range: [low, high],
        judge_model: call.result.model,
        attempts: call.attempts,
      },
      usage: {
        latency_ms: call.result.latency_ms,
        input_tokens: call.result.input_tokens,
        output_tokens: call.result.output_tokens,
        cost_usd: call.cost_usd,
      },
    };
  }
}
