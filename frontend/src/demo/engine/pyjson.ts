/**
 * Python-compatible JSON: `json.loads` with CPython's exact error messages and positions, and
 * `json.dumps` with Python's separators, float formatting, and `ensure_ascii` escaping.
 */

import { pyFloatRepr, pyLen, pyNumberRepr } from "./py";

export class JsonDecodeError extends Error {
  constructor(
    readonly msg: string,
    readonly lineno: number,
    readonly colno: number,
  ) {
    super(`${msg}: line ${lineno} column ${colno}`);
    this.name = "JsonDecodeError";
  }
}

/** A number that Python holds as a float, so it prints as `1.0` rather than `1`. */
export class PyFloat {
  constructor(readonly value: number) {}
}

// --- loads -----------------------------------------------------------------------------------

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER_RE = /(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

class Decoder {
  constructor(private readonly s: string) {}

  fail(msg: string, pos: number): never {
    const before = this.s.slice(0, pos);
    const lineno = before.split("\n").length;
    const lastNewline = before.lastIndexOf("\n");
    const colno = pyLen(before.slice(lastNewline + 1)) + 1;
    throw new JsonDecodeError(msg, lineno, colno);
  }

  ws(i: number): number {
    while (i < this.s.length && WS.has(this.s[i])) i++;
    return i;
  }

  /** Mirrors `scan_once`: returns [value, end] or null when no value starts at `i`. */
  value(i: number): [unknown, number] | null {
    const s = this.s;
    const ch = s[i];
    if (ch === undefined) return null;
    if (ch === '"') return this.string(i + 1);
    if (ch === "{") return this.object(i + 1);
    if (ch === "[") return this.array(i + 1);
    if (ch === "n" && s.startsWith("null", i)) return [null, i + 4];
    if (ch === "t" && s.startsWith("true", i)) return [true, i + 4];
    if (ch === "f" && s.startsWith("false", i)) return [false, i + 5];
    NUMBER_RE.lastIndex = i;
    const number = NUMBER_RE.exec(s);
    if (number) return [Number(number[0]), i + number[0].length];
    if (ch === "N" && s.startsWith("NaN", i)) return [NaN, i + 3];
    if (ch === "I" && s.startsWith("Infinity", i)) return [Infinity, i + 8];
    if (ch === "-" && s.startsWith("-Infinity", i)) return [-Infinity, i + 9];
    return null;
  }

  string(i: number): [string, number] {
    const s = this.s;
    const begin = i - 1;
    let out = "";
    for (;;) {
      let j = i;
      while (j < s.length && s[j] !== '"' && s[j] !== "\\" && s.charCodeAt(j) >= 0x20) j++;
      if (j >= s.length) this.fail("Unterminated string starting at", begin);
      out += s.slice(i, j);
      const terminator = s[j];
      if (terminator === '"') return [out, j + 1];
      if (terminator !== "\\") this.fail("Invalid control character at", j);
      const esc = s[j + 1];
      if (esc === undefined) this.fail("Unterminated string starting at", begin);
      if (esc !== "u") {
        if (!(esc in ESCAPES)) this.fail("Invalid \\escape", j);
        out += ESCAPES[esc];
        i = j + 2;
        continue;
      }
      let code = this.hex4(j + 2, j + 1);
      i = j + 6;
      if (code >= 0xd800 && code <= 0xdbff && s[i] === "\\" && s[i + 1] === "u") {
        const low = this.hex4(i + 2, i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i += 6;
        }
      }
      out += code > 0xffff ? String.fromCodePoint(code) : String.fromCharCode(code);
    }
  }

  hex4(start: number, errorPos: number): number {
    const digits = this.s.slice(start, start + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("Invalid \\uXXXX escape", errorPos);
    return parseInt(digits, 16);
  }

  object(i: number): [Record<string, unknown>, number] {
    const s = this.s;
    const result: Record<string, unknown> = {};
    i = this.ws(i);
    if (s[i] === "}") return [result, i + 1];
    if (s[i] !== '"') this.fail("Expecting property name enclosed in double quotes", i);
    for (;;) {
      const [key, afterKey] = this.string(i + 1);
      i = this.ws(afterKey);
      if (s[i] !== ":") this.fail("Expecting ':' delimiter", i);
      i = this.ws(i + 1);
      const parsed = this.value(i);
      if (parsed === null) this.fail("Expecting value", i);
      result[key] = parsed[0];
      i = this.ws(parsed[1]);
      if (s[i] === "}") return [result, i + 1];
      if (s[i] !== ",") this.fail("Expecting ',' delimiter", i);
      const comma = i;
      i = this.ws(i + 1);
      if (s[i] !== '"') {
        if (s[i] === "}") this.fail("Illegal trailing comma before end of object", comma);
        this.fail("Expecting property name enclosed in double quotes", i);
      }
    }
  }

  array(i: number): [unknown[], number] {
    const s = this.s;
    const result: unknown[] = [];
    i = this.ws(i);
    if (s[i] === "]") return [result, i + 1];
    for (;;) {
      const parsed = this.value(i);
      if (parsed === null) this.fail("Expecting value", i);
      result.push(parsed[0]);
      i = this.ws(parsed[1]);
      if (s[i] === "]") return [result, i + 1];
      if (s[i] !== ",") this.fail("Expecting ',' delimiter", i);
      const comma = i;
      i = this.ws(i + 1);
      if (s[i] === "]") this.fail("Illegal trailing comma before end of array", comma);
    }
  }
}

/** `json.loads`. Throws {@link JsonDecodeError} with Python's message, line, and column. */
export function loads(text: string): unknown {
  const decoder = new Decoder(text);
  const start = decoder.ws(0);
  const parsed = decoder.value(start);
  if (parsed === null) return decoder.fail("Expecting value", start);
  const end = decoder.ws(parsed[1]);
  if (end !== text.length) decoder.fail("Extra data", end);
  return parsed[0];
}

// --- dumps -----------------------------------------------------------------------------------

export type DumpOptions = { indent?: number; ensureAscii?: boolean };

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function hex(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

function encodeString(text: string, ensureAscii: boolean): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[ch];
    else if (code < 0x20) out += hex(code);
    else if (ensureAscii && code > 0x7e) out += hex(code);
    else out += ch;
  }
  return out + '"';
}

function encodeNumber(value: number, isFloat: boolean): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return isFloat ? pyFloatRepr(value) : pyNumberRepr(value);
}

/** `json.dumps`. Integral numbers print as integers unless wrapped in {@link PyFloat}. */
export function dumps(value: unknown, options: DumpOptions = {}): string {
  const { indent, ensureAscii = true } = options;
  const itemSeparator = indent === undefined ? ", " : ",";

  const encode = (item: unknown, level: number): string => {
    if (item === null || item === undefined) return "null";
    if (item === true) return "true";
    if (item === false) return "false";
    if (item instanceof PyFloat) return encodeNumber(item.value, true);
    if (typeof item === "number") return encodeNumber(item, false);
    if (typeof item === "string") return encodeString(item, ensureAscii);
    const entries: string[] = Array.isArray(item)
      ? item.map((v) => encode(v, level + 1))
      : Object.entries(item as Record<string, unknown>).map(
          ([k, v]) => `${encodeString(k, ensureAscii)}: ${encode(v, level + 1)}`,
        );
    const [open, close] = Array.isArray(item) ? ["[", "]"] : ["{", "}"];
    if (entries.length === 0) return open + close;
    if (indent === undefined) return open + entries.join(itemSeparator) + close;
    const inner = "\n" + " ".repeat(indent * (level + 1));
    const outer = "\n" + " ".repeat(indent * level);
    return open + inner + entries.join(itemSeparator + inner) + outer + close;
  };
  return encode(value, 0);
}
