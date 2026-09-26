import { describe, expect, it } from "vitest";

import { unitGolden, type Golden } from "../golden";
import { pyCasefold, pyFloatRepr, pyLen, pyRepr, pyRound, pySplit, pyStrip, pySum } from "./py";
import { dumps, JsonDecodeError, loads } from "./pyjson";
import { sha256Hex } from "./sha256";

const python = unitGolden().python;

/**
 * Inputs whose Python output cannot be reproduced from a JavaScript number: `-3e2` is the float
 * `-300.0` in Python but the same double as the integer `-300`, and 12345678901234567890 does
 * not fit in a double at all.
 */
const KNOWN_NUMBER_DIVERGENCES = new Set(["  [1, 2.5, -3e2, 0.1]  ", "12345678901234567890"]);

describe("json.loads / json.dumps parity", () => {
  const cases = python.json.filter((c: Golden) => !KNOWN_NUMBER_DIVERGENCES.has(c.input));
  it.each<Golden>(cases)("loads $input", (c) => {
    if (c.error) {
      let thrown: unknown;
      try {
        loads(c.input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(JsonDecodeError);
      const { msg, lineno, colno } = thrown as JsonDecodeError;
      expect({ msg, lineno, colno }).toEqual(c.error);
    } else {
      expect(dumps(loads(c.input))).toBe(c.dumped);
    }
  });

  it.each<Golden>(python.dumps)("dumps $input", (c) => {
    const value = loads(c.input);
    expect(dumps(value)).toBe(c.default);
    expect(dumps(value, { indent: 2 })).toBe(c.indent2);
    expect(dumps(value, { indent: 2, ensureAscii: false })).toBe(c.unicode_indent2);
  });
});

describe("numbers", () => {
  it("formats floats like repr()", () => {
    for (const c of python.float_repr) expect(pyFloatRepr(c.value)).toBe(c.repr);
  });

  it("rounds half to even on the exact binary value", () => {
    for (const c of python.round) {
      expect(pyRound(c.value, c.ndigits ?? undefined), `${c.value}, ${c.ndigits}`).toBe(c.result);
    }
  });

  it("sums with compensation like CPython", () => {
    for (const c of python.sum) expect(pySum(c.values)).toBe(c.result);
  });
});

describe("strings", () => {
  it("reprs like Python", () => {
    for (const c of python.repr) expect(pyRepr(c.value)).toBe(c.repr);
  });

  it("strips, splits, folds, and measures like Python", () => {
    for (const c of python.strings) {
      expect(pyStrip(c.value)).toBe(c.strip);
      expect(pySplit(c.value)).toEqual(c.split);
      expect(pyCasefold(c.value)).toBe(c.casefold);
      expect(c.value.toLowerCase()).toBe(c.lower);
      expect(pyLen(c.value)).toBe(c.len);
    }
  });

  it("hashes like hashlib", () => {
    for (const c of python.hash) expect(sha256Hex(c.parts.join("\x1f"))).toBe(c.digest);
  });
});
