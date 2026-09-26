/**
 * Small Python-compatibility helpers.
 *
 * The demo engine is a port of the Python backend and must produce byte-identical outputs,
 * scores, and reasons. These helpers reproduce the few places where Python and JavaScript
 * disagree: rounding, float formatting, `sum()`, `repr()`, equality, whitespace handling, and
 * string lengths measured in code points rather than UTF-16 units.
 */

// --- numbers ---------------------------------------------------------------------------------

/** `sum()` for floats, which CPython (3.12+) computes with Neumaier compensated summation. */
export function pySum(values: Iterable<number>): number {
  let total = 0;
  let compensation = 0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) compensation += total - t + x;
    else compensation += x - t + total;
    total = t;
  }
  if (compensation && Number.isFinite(compensation)) total += compensation;
  return total;
}

/** `statistics`-free mean as the backend computes it: `sum(items) / len(items)`. */
export function pyMean(values: Iterable<number>): number | null {
  const items = [...values];
  return items.length ? pySum(items) / items.length : null;
}

/** The exact decimal expansion of a finite double: |x| = digits * 10^-scale. */
function exactDecimal(x: number): { negative: boolean; digits: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const biasedExponent = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << BigInt(32)) | BigInt(lo);
  let exponent: number;
  if (biasedExponent === 0) {
    exponent = -1074;
  } else {
    mantissa |= BigInt(1) << BigInt(52);
    exponent = biasedExponent - 1075;
  }
  if (exponent >= 0) return { negative, digits: mantissa << BigInt(exponent), scale: 0 };
  // mantissa / 2^k == mantissa * 5^k / 10^k
  const k = -exponent;
  return { negative, digits: mantissa * BigInt(5) ** BigInt(k), scale: k };
}

/**
 * Python's `round()`: round-half-to-even on the exact binary value. Without `ndigits` it returns
 * an integer, like Python's `round(x)`.
 */
export function pyRound(x: number, ndigits?: number): number {
  if (!Number.isFinite(x)) return x;
  if (ndigits === undefined) {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  }
  const { negative, digits, scale } = exactDecimal(x);
  if (scale <= ndigits) return x;
  const divisor = BigInt(10) ** BigInt(scale - ndigits);
  let kept = digits / divisor;
  const remainder = digits % divisor;
  const twice = remainder * BigInt(2);
  if (twice > divisor || (twice === divisor && kept % BigInt(2) === BigInt(1))) kept += BigInt(1);
  const text = kept.toString().padStart(ndigits + 1, "0");
  const decimal = ndigits
    ? `${text.slice(0, text.length - ndigits)}.${text.slice(text.length - ndigits)}`
    : text;
  const value = Number(decimal);
  return negative ? -value : value;
}

/** `repr(float)` / `str(float)`: shortest round-trip digits, Python's notation rules. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, exp] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exp);
  const sign = x < 0 ? "-" : "";
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
    const fraction = digits.slice(exponent + 1);
    return `${sign}${whole}.${fraction || "0"}`;
  }
  const head = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  const expText = `${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  return `${sign}${head}e${expText}`;
}

/**
 * How Python prints a number that came from JSON data. JavaScript cannot tell `3` from `3.0`,
 * so integral values print as integers; beyond 1e16 they were almost certainly floats.
 */
export function pyNumberRepr(x: number): string {
  return Number.isInteger(x) && Math.abs(x) < 1e16 ? String(x) : pyFloatRepr(x);
}

/** `math.isclose` with Python's defaults (`rel_tol=1e-09`, `abs_tol=0`). */
export function pyIsClose(a: number, b: number, relTol = 1e-9, absTol = 0): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(b - a);
  return diff <= Math.abs(relTol * b) || diff <= Math.abs(relTol * a) || diff <= absTol;
}

// --- equality --------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `==` on JSON-like values (booleans compare equal to 1 and 0, as in Python). */
export function pyEq(a: unknown, b: unknown): boolean {
  const numeric = (v: unknown) => typeof v === "number" || typeof v === "boolean";
  if (numeric(a) && numeric(b)) return Number(a) === Number(b);
  if (a === null || b === null) return a === b;
  if (typeof a === "string" || typeof b === "string") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => pyEq(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && pyEq(a[key], b[key]));
  }
  return false;
}

export const isDict = isPlainObject;

// --- strings ---------------------------------------------------------------------------------

const PY_WHITESPACE =
  "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, "g");
const SPLIT_RE = new RegExp(`[${PY_WHITESPACE}]+`);

/** `str.strip()` with Python's definition of whitespace. */
export function pyStrip(text: string): string {
  return text.replace(STRIP_RE, "");
}

/** `str.split()` with no separator. */
export function pySplit(text: string): string[] {
  return pyStrip(text).split(SPLIT_RE).filter(Boolean);
}

/** `str.casefold()` (close enough: full case folding via upper-then-lower). */
export function pyCasefold(text: string): string {
  return text.toUpperCase().toLowerCase();
}

/** `len(text)`: Python counts code points, not UTF-16 units. */
export function pyLen(text: string): number {
  return Array.from(text).length;
}

/** `text[start:end]` by code points. */
export function pySlice(text: string, start: number, end?: number): string {
  return Array.from(text).slice(start, end).join("");
}

const NON_PRINTABLE_RE = /[\p{C}\p{Z}]/u;

/** `repr(str)`. */
export function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x7f || ch === " " || !NON_PRINTABLE_RE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

/** Python's default string ordering (by code point). */
export function pyCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (diff) return diff;
  }
  return x.length - y.length;
}
