/**
 * Port of `app/evaluators/registry.py`.
 *
 * Config validation is driven by each type's JSON schema (exported from the backend's Pydantic
 * models), and reports errors with Pydantic's wording, so the demo and the real API reject the
 * same configs with the same messages and store the same normalised config.
 */

import { isDict, pyLen } from "../py";
import type { Evaluator, ModelCaller } from "./base";
import {
  compilePythonRegex,
  ContainsEvaluator,
  ExactMatchEvaluator,
  FieldMatchEvaluator,
  JsonSchemaEvaluator,
  JsonValidEvaluator,
  RegexEvaluator,
  RequiredFieldsEvaluator,
} from "./deterministic";
import { LLMJudgeEvaluator, type JudgeConfig } from "./judge";
import { checkSchema, pyReprValue } from "./jsonschema";

export type EvaluatorTypeInfo = {
  type: string;
  label: string;
  description: string;
  kind: string;
  scoring: string;
  requires_expected: boolean;
  config_schema: Record<string, unknown>;
};

export type ConfigErrorDetail = { loc: string[]; message: string };

export class InvalidEvaluatorConfig extends Error {
  constructor(
    message: string,
    readonly errors: ConfigErrorDetail[] = [],
  ) {
    super(message);
    this.name = "InvalidEvaluatorConfig";
  }
}

type Config = Record<string, unknown>;
type Schema = Record<string, unknown>;

const FACTORIES: Record<string, (config: Config, caller: ModelCaller | null) => Evaluator> = {
  exact_match: (c) => new ExactMatchEvaluator(c),
  contains: (c) => new ContainsEvaluator(c),
  regex: (c) => new RegexEvaluator(c),
  json_valid: (c) => new JsonValidEvaluator(c),
  json_schema: (c) => new JsonSchemaEvaluator(c),
  required_fields: (c) => new RequiredFieldsEvaluator(c),
  field_match: (c) => new FieldMatchEvaluator(c),
  llm_judge: (c, caller) => {
    if (caller === null) throw new Error("LLM judge evaluators require a model caller");
    return new LLMJudgeEvaluator(c as JudgeConfig, caller);
  },
};

const FIELD_VALIDATORS: Record<string, Record<string, (value: unknown) => void>> = {
  regex: {
    pattern: (value) => {
      try {
        compilePythonRegex(String(value));
      } catch (error) {
        throw new Error(`Invalid regular expression: ${(error as Error).message}`);
      }
    },
  },
  json_schema: {
    json_schema: (value) => {
      try {
        checkSchema(value);
      } catch (error) {
        throw new Error(`Invalid JSON Schema: ${(error as Error).message}`);
      }
    },
  },
};

const MODEL_VALIDATORS: Record<string, (config: Config) => void> = {
  llm_judge: (config) => {
    if ((config.score_max as number) <= (config.score_min as number)) {
      throw new Error("score_max must be greater than score_min");
    }
  },
};

// --- Pydantic-style coercion -----------------------------------------------------------------

class FieldError extends Error {}

const TRUE_WORDS = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_WORDS = new Set(["0", "off", "f", "false", "n", "no"]);
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:inf|infinity|nan)$/i;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function literalList(values: unknown[]): string {
  const shown = values.map(pyReprValue);
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}` : shown[0];
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0 || value === 1) return value === 1;
    throw new FieldError("Input should be a valid boolean, unable to interpret input");
  }
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new FieldError("Input should be a valid boolean, unable to interpret input");
  }
  throw new FieldError("Input should be a valid boolean");
}

function coerceNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string") {
    const text = value.trim();
    if (NUMBER_RE.test(text)) {
      const lower = text.toLowerCase().replace(/^\+/, "");
      if (lower.endsWith("inf") || lower.endsWith("infinity")) {
        return lower.startsWith("-") ? -Infinity : Infinity;
      }
      return lower.endsWith("nan") ? NaN : Number(text);
    }
    throw new FieldError("Input should be a valid number, unable to parse string as a number");
  }
  throw new FieldError("Input should be a valid number");
}

function coerceInteger(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value;
    throw new FieldError("Input should be a valid integer, got a number with a fractional part");
  }
  if (typeof value === "string") {
    if (/^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
    throw new FieldError("Input should be a valid integer, unable to parse string as an integer");
  }
  throw new FieldError("Input should be a valid integer");
}

function checkBounds(value: number, schema: Schema): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema as Record<string, number>;
  if (minimum !== undefined && !(value >= minimum)) {
    throw new FieldError(`Input should be greater than or equal to ${minimum}`);
  }
  if (maximum !== undefined && !(value <= maximum)) {
    throw new FieldError(`Input should be less than or equal to ${maximum}`);
  }
  if (exclusiveMinimum !== undefined && !(value > exclusiveMinimum)) {
    throw new FieldError(`Input should be greater than ${exclusiveMinimum}`);
  }
  if (exclusiveMaximum !== undefined && !(value < exclusiveMaximum)) {
    throw new FieldError(`Input should be less than ${exclusiveMaximum}`);
  }
}

function validateValue(
  value: unknown,
  schema: Schema,
  loc: string[],
  errors: ConfigErrorDetail[],
): unknown {
  const anyOf = schema.anyOf as Schema[] | undefined;
  if (anyOf) {
    if (value === null && anyOf.some((s) => s.type === "null")) return null;
    const option = anyOf.find((s) => s.type !== "null") ?? {};
    return validateValue(value, option, loc, errors);
  }
  try {
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.some((allowed) => allowed === value)) {
        throw new FieldError(`Input should be ${literalList(schema.enum)}`);
      }
      return value;
    }
    switch (schema.type) {
      case "string": {
        if (typeof value !== "string") throw new FieldError("Input should be a valid string");
        const { minLength, maxLength } = schema as Record<string, number>;
        if (minLength !== undefined && pyLen(value) < minLength) {
          throw new FieldError(`String should have at least ${plural(minLength, "character")}`);
        }
        if (maxLength !== undefined && pyLen(value) > maxLength) {
          throw new FieldError(`String should have at most ${plural(maxLength, "character")}`);
        }
        return value;
      }
      case "boolean":
        return coerceBoolean(value);
      case "number": {
        const number = coerceNumber(value);
        checkBounds(number, schema);
        return number;
      }
      case "integer": {
        const integer = coerceInteger(value);
        checkBounds(integer, schema);
        return integer;
      }
      case "array": {
        if (!Array.isArray(value)) throw new FieldError("Input should be a valid list");
        const itemSchema = (schema.items as Schema | undefined) ?? {};
        const before = errors.length;
        const items = value.map((item, i) =>
          validateValue(item, itemSchema, [...loc, String(i)], errors),
        );
        if (errors.length > before) return undefined;
        const { minItems, maxItems } = schema as Record<string, number>;
        if (minItems !== undefined && items.length < minItems) {
          throw new FieldError(
            `List should have at least ${plural(minItems, "item")} after validation, not ${items.length}`,
          );
        }
        if (maxItems !== undefined && items.length > maxItems) {
          throw new FieldError(
            `List should have at most ${plural(maxItems, "item")} after validation, not ${items.length}`,
          );
        }
        return items;
      }
      case "object":
        if (!isDict(value)) throw new FieldError("Input should be a valid dictionary");
        return value;
      default:
        return value;
    }
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    errors.push({ loc, message: error.message });
    return undefined;
  }
}

function defaultFor(schema: Schema): unknown {
  if ("default" in schema) return structuredClone(schema.default);
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return null;
}

export class EvaluatorRegistry {
  private readonly types: Map<string, EvaluatorTypeInfo>;

  constructor(types: EvaluatorTypeInfo[]) {
    this.types = new Map(types.map((t) => [t.type, t]));
  }

  list(): EvaluatorTypeInfo[] {
    return [...this.types.values()];
  }

  get(type: string): EvaluatorTypeInfo {
    const spec = this.types.get(type);
    if (!spec) {
      const known = [...this.types.keys()].sort().join(", ");
      throw new InvalidEvaluatorConfig(`Unknown evaluator type '${type}'. Known types: ${known}`);
    }
    return spec;
  }

  /** Validate and fill defaults, returning the canonical config that gets stored. */
  normalizeConfig(type: string, config: unknown): Config {
    const spec = this.get(type);
    const schema = spec.config_schema;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const required = new Set((schema.required ?? []) as string[]);
    const input = isDict(config) ? config : {};
    const errors: ConfigErrorDetail[] = [];
    const result: Config = {};

    for (const [name, property] of Object.entries(properties)) {
      if (!Object.hasOwn(input, name)) {
        if (required.has(name)) errors.push({ loc: [name], message: "Field required" });
        else result[name] = defaultFor(property);
        continue;
      }
      const before = errors.length;
      const value = validateValue(input[name], property, [name], errors);
      if (errors.length > before) continue;
      const validator = FIELD_VALIDATORS[type]?.[name];
      try {
        validator?.(value);
      } catch (error) {
        errors.push({ loc: [name], message: `Value error, ${(error as Error).message}` });
        continue;
      }
      result[name] = value;
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(input)) {
        if (!Object.hasOwn(properties, name)) {
          errors.push({ loc: [name], message: "Extra inputs are not permitted" });
        }
      }
    }
    if (errors.length === 0) {
      try {
        MODEL_VALIDATORS[type]?.(result);
      } catch (error) {
        errors.push({ loc: [], message: `Value error, ${(error as Error).message}` });
      }
    }
    if (errors.length) {
      throw new InvalidEvaluatorConfig(`Invalid configuration for ${spec.label} evaluator`, errors);
    }
    return result;
  }

  build(type: string, config: unknown, caller: ModelCaller | null = null): Evaluator {
    return FACTORIES[this.get(type).type](this.normalizeConfig(type, config), caller);
  }
}
