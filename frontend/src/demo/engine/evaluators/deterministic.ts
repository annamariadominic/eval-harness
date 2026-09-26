/** Port of `app/evaluators/deterministic.py`: pure checks, no model calls. */

import { isDict, pyCasefold, pyEq, pyIsClose, pyLen, pyRepr, pySlice, pySplit } from "../py";
import {
  binary,
  EvaluatorError,
  type EvaluationSample,
  type Evaluator,
  type EvaluatorOutcome,
} from "./base";
import { SchemaValidator } from "./jsonschema";
import { JsonParseError, parseJsonOutput, PathNotFoundError, resolvePath, toText } from "./output";

type Config = Record<string, unknown>;

function expectedValue(sample: EvaluationSample, path: string | null): unknown {
  if (sample.expected === null || sample.expected === undefined) {
    throw new EvaluatorError("This evaluator needs an expected output, but the test case has none");
  }
  if (path === null) return sample.expected;
  try {
    return resolvePath(sample.expected, path);
  } catch (error) {
    if (error instanceof PathNotFoundError) {
      throw new EvaluatorError(`Expected output has no field '${path}'`);
    }
    throw error;
  }
}

function normalise(text: string, caseSensitive: boolean, collapseWhitespace: boolean): string {
  const collapsed = collapseWhitespace ? pySplit(text).join(" ") : text;
  return caseSensitive ? collapsed : pyCasefold(collapsed);
}

function truncate(text: string, max = 120): string {
  return pyLen(text) <= max ? text : pySlice(text, 0, max - 1) + "…";
}

function isParseOrPathError(error: unknown): boolean {
  return error instanceof JsonParseError || error instanceof PathNotFoundError;
}

// --- exact match -----------------------------------------------------------------------------

export class ExactMatchEvaluator implements Evaluator {
  constructor(private readonly config: Config) {}

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    const { expected_path, output_path, case_sensitive, collapse_whitespace } = this.config as {
      expected_path: string | null;
      output_path: string | null;
      case_sensitive: boolean;
      collapse_whitespace: boolean;
    };
    const expected = expectedValue(sample, expected_path);
    let actual: unknown = sample.output;
    if (output_path !== null) {
      try {
        actual = resolvePath(parseJsonOutput(sample.output), output_path);
      } catch (error) {
        if (!isParseOrPathError(error)) throw error;
        return binary(false, `Output has no JSON field '${output_path}'`);
      }
    }

    let matched: boolean;
    if (typeof expected === "string" || typeof actual === "string") {
      matched =
        normalise(toText(actual), case_sensitive, collapse_whitespace) ===
        normalise(toText(expected), case_sensitive, collapse_whitespace);
    } else {
      matched = pyEq(actual, expected);
    }
    if (matched) return binary(true, "Output exactly matches the expected value");
    return binary(
      false,
      `Expected ${pyRepr(toText(expected))} but got ${pyRepr(truncate(toText(actual)))}`,
    );
  }
}

// --- contains --------------------------------------------------------------------------------

export class ContainsEvaluator implements Evaluator {
  constructor(private readonly config: Config) {}

  private needles(sample: EvaluationSample): string[] {
    const { values, expected_path } = this.config as {
      values: string[];
      expected_path: string | null;
    };
    const needles = [...values];
    const hasExpected = sample.expected !== null && sample.expected !== undefined;
    if (expected_path !== null || (needles.length === 0 && hasExpected)) {
      const expected = expectedValue(sample, expected_path);
      const items = Array.isArray(expected) ? expected : [expected];
      needles.push(...items.map(toText));
    }
    if (needles.length === 0) {
      throw new EvaluatorError("No values configured and no expected output to search for");
    }
    return needles;
  }

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    const { mode, case_sensitive } = this.config as { mode: string; case_sensitive: boolean };
    const needles = this.needles(sample);
    const haystack = normalise(sample.output, case_sensitive, true);
    const found = needles.filter((n) => haystack.includes(normalise(n, case_sensitive, true)));
    const missing = needles.filter((n) => !found.includes(n));
    let passed: boolean;
    let score: number;
    if (mode === "any") {
      passed = found.length > 0;
      score = passed ? 1.0 : 0.0;
    } else {
      passed = missing.length === 0;
      score = found.length / needles.length;
    }
    const reason =
      `Found ${found.length} of ${needles.length} expected values` +
      (missing.length ? `; missing ${missing.slice(0, 5).map(pyRepr).join(", ")}` : "");
    return { score, passed, reason, details: { found, missing }, usage: null };
  }
}

// --- regex -----------------------------------------------------------------------------------

/** Translate the Python-only parts of a regular expression into JavaScript syntax. */
export function pythonPatternToJs(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "A") out += "(?<![\\s\\S])";
      else if (next === "Z") out += "(?![\\s\\S])";
      else out += ch + next;
      i++;
    } else if (pattern.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
    } else if (pattern.startsWith("(?P=", i)) {
      const end = pattern.indexOf(")", i);
      out += `\\k<${pattern.slice(i + 4, end)}>`;
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
}

export function compilePythonRegex(
  pattern: string,
  flags: { ignoreCase?: boolean; multiline?: boolean; dotall?: boolean } = {},
): RegExp {
  const jsFlags =
    (flags.ignoreCase ? "i" : "") + (flags.multiline ? "m" : "") + (flags.dotall ? "s" : "");
  return new RegExp(pythonPatternToJs(pattern), jsFlags);
}

export class RegexEvaluator implements Evaluator {
  private readonly regex: RegExp;

  constructor(private readonly config: Config) {
    const { pattern, ignore_case, multiline, dotall } = config as {
      pattern: string;
      ignore_case: boolean;
      multiline: boolean;
      dotall: boolean;
    };
    this.regex = compilePythonRegex(pattern, { ignoreCase: ignore_case, multiline, dotall });
  }

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    const shouldMatch = this.config.should_match as boolean;
    const match = this.regex.exec(sample.output);
    const passed = (match !== null) === shouldMatch;
    let reason = match !== null ? `Pattern matched ${pyRepr(match[0])}` : "Pattern did not match";
    if (!shouldMatch) reason += " (expected no match)";
    return binary(passed, reason, { match: match !== null ? match[0] : null });
  }
}

// --- JSON validity and schema ----------------------------------------------------------------

export class JsonValidEvaluator implements Evaluator {
  constructor(private readonly config: Config) {}

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    try {
      parseJsonOutput(sample.output, this.config.allow_code_fence as boolean);
    } catch (error) {
      if (error instanceof JsonParseError) return binary(false, error.message);
      throw error;
    }
    return binary(true, "Output is valid JSON");
  }
}

export class JsonSchemaEvaluator implements Evaluator {
  private readonly validator: SchemaValidator;

  constructor(private readonly config: Config) {
    this.validator = new SchemaValidator(config.json_schema as Record<string, unknown>);
  }

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    let value: unknown;
    try {
      value = parseJsonOutput(sample.output, this.config.allow_code_fence as boolean);
    } catch (error) {
      if (error instanceof JsonParseError) return binary(false, error.message);
      throw error;
    }
    const violations = this.validator.violations(value);
    if (violations.length === 0) return binary(true, "Output conforms to the schema");
    const messages = violations.slice(0, 10);
    return binary(false, `${violations.length} schema violation(s): ${messages[0]}`, {
      violations: messages,
    });
  }
}

// --- required fields -------------------------------------------------------------------------

export class RequiredFieldsEvaluator implements Evaluator {
  constructor(private readonly config: Config) {}

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    const { fields, allow_null, allow_code_fence } = this.config as {
      fields: string[];
      allow_null: boolean;
      allow_code_fence: boolean;
    };
    let value: unknown;
    try {
      value = parseJsonOutput(sample.output, allow_code_fence);
    } catch (error) {
      if (!(error instanceof JsonParseError)) throw error;
      return {
        score: 0.0,
        passed: false,
        reason: error.message,
        details: { missing: fields },
        usage: null,
      };
    }
    const missing: string[] = [];
    for (const path of fields) {
      let found: unknown;
      try {
        found = resolvePath(value, path);
      } catch (error) {
        if (!(error instanceof PathNotFoundError)) throw error;
        missing.push(path);
        continue;
      }
      if (found === null && !allow_null) missing.push(path);
    }
    const present = fields.length - missing.length;
    const reason = missing.length
      ? `Missing ${missing.length} of ${fields.length} fields: ${missing.join(", ")}`
      : "All required fields are present";
    return {
      score: present / fields.length,
      passed: missing.length === 0,
      reason,
      details: { missing },
      usage: null,
    };
  }
}

// --- field-level structured comparison -------------------------------------------------------

export class FieldMatchEvaluator implements Evaluator {
  constructor(private readonly config: Config) {}

  private valuesMatch(expected: unknown, actual: unknown): boolean {
    const { numeric_tolerance, case_sensitive } = this.config as {
      numeric_tolerance: number;
      case_sensitive: boolean;
    };
    if (typeof expected === "boolean" || typeof actual === "boolean") return pyEq(expected, actual);
    if (typeof expected === "number" && typeof actual === "number") {
      return numeric_tolerance === 0
        ? pyIsClose(expected, actual)
        : pyIsClose(expected, actual, numeric_tolerance);
    }
    if (typeof expected === "string" && typeof actual === "string") {
      return normalise(expected, case_sensitive, true) === normalise(actual, case_sensitive, true);
    }
    return pyEq(expected, actual);
  }

  async evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome> {
    const expected = expectedValue(sample, null);
    let fields = this.config.fields as string[] | null;
    if (fields === null) {
      if (!isDict(expected)) {
        throw new EvaluatorError("Field match needs an expected JSON object or explicit fields");
      }
      fields = Object.keys(expected);
    }
    if (fields.length === 0) throw new EvaluatorError("No fields to compare");

    let actual: unknown;
    try {
      actual = parseJsonOutput(sample.output, this.config.allow_code_fence as boolean);
    } catch (error) {
      if (!(error instanceof JsonParseError)) throw error;
      return { score: 0.0, passed: false, reason: error.message, details: {}, usage: null };
    }

    const comparisons: Array<Record<string, unknown>> = [];
    for (const path of fields) {
      let expectedValueAtPath: unknown;
      try {
        expectedValueAtPath = resolvePath(expected, path);
      } catch (error) {
        if (!(error instanceof PathNotFoundError)) throw error;
        throw new EvaluatorError(`Expected output has no field '${path}'`);
      }
      let actualValue: unknown;
      let matched: boolean;
      try {
        actualValue = resolvePath(actual, path);
        matched = this.valuesMatch(expectedValueAtPath, actualValue);
      } catch (error) {
        if (!(error instanceof PathNotFoundError)) throw error;
        actualValue = null;
        matched = false;
      }
      comparisons.push({
        field: path,
        expected: expectedValueAtPath,
        actual: actualValue,
        match: matched,
      });
    }

    const matchedCount = comparisons.filter((c) => c.match).length;
    const score = matchedCount / comparisons.length;
    const mismatched = comparisons.filter((c) => !c.match).map((c) => c.field as string);
    const reason = mismatched.length
      ? `${matchedCount} of ${comparisons.length} fields match; mismatched: ${mismatched.join(", ")}`
      : `All ${comparisons.length} fields match`;
    return {
      score,
      passed: score >= (this.config.pass_threshold as number),
      reason,
      details: { fields: comparisons },
      usage: null,
    };
  }
}
