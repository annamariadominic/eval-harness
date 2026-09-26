/**
 * Pydantic-style validation driven by the JSON schemas Pydantic generates.
 *
 * The backend validates request bodies and evaluator configs with Pydantic models; their JSON
 * schemas (in the OpenAPI document and the evaluator-type metadata) are available to the demo.
 * This validates against those schemas with Pydantic's lax coercions, error locations, messages,
 * and error type codes, and fills defaults, so the demo accepts and rejects the same input.
 */

import { isDict, pyLen } from "./py";
import { pyReprValue } from "./evaluators/jsonschema";

export type Schema = Record<string, unknown>;

export type ValidationIssue = { loc: string[]; message: string; type: string };

export type ObjectValidationOptions = {
  /** Resolves `{"$ref": "#/components/schemas/X"}` references. */
  resolveRef?: (ref: string) => Schema;
  /** `@field_validator`s, keyed by field name; throw an Error to report a value error. */
  fieldValidators?: Record<string, (value: unknown) => unknown>;
  /** `@model_validator(mode="after")`; throw an Error to report a value error at `loc: []`. */
  modelValidator?: (value: Record<string, unknown>) => void;
  /** Accepted input names per field (Pydantic `AliasChoices`), checked in order. */
  aliases?: Record<string, string[]>;
  locPrefix?: string[];
};

class FieldError extends Error {
  constructor(
    message: string,
    readonly type: string,
  ) {
    super(message);
  }
}

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
    throw new FieldError(
      "Input should be a valid boolean, unable to interpret input",
      "bool_parsing",
    );
  }
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
    throw new FieldError(
      "Input should be a valid boolean, unable to interpret input",
      "bool_parsing",
    );
  }
  throw new FieldError("Input should be a valid boolean", "bool_type");
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
    throw new FieldError(
      "Input should be a valid number, unable to parse string as a number",
      "float_parsing",
    );
  }
  throw new FieldError("Input should be a valid number", "float_type");
}

function coerceInteger(value: unknown): number {
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value;
    throw new FieldError(
      "Input should be a valid integer, got a number with a fractional part",
      "int_from_float",
    );
  }
  if (typeof value === "string") {
    if (/^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
    throw new FieldError(
      "Input should be a valid integer, unable to parse string as an integer",
      "int_parsing",
    );
  }
  throw new FieldError("Input should be a valid integer", "int_type");
}

function checkBounds(value: number, schema: Schema): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = schema as Record<string, number>;
  if (minimum !== undefined && !(value >= minimum)) {
    throw new FieldError(
      `Input should be greater than or equal to ${minimum}`,
      "greater_than_equal",
    );
  }
  if (maximum !== undefined && !(value <= maximum)) {
    throw new FieldError(`Input should be less than or equal to ${maximum}`, "less_than_equal");
  }
  if (exclusiveMinimum !== undefined && !(value > exclusiveMinimum)) {
    throw new FieldError(`Input should be greater than ${exclusiveMinimum}`, "greater_than");
  }
  if (exclusiveMaximum !== undefined && !(value < exclusiveMaximum)) {
    throw new FieldError(`Input should be less than ${exclusiveMaximum}`, "less_than");
  }
}

function validateValue(
  value: unknown,
  schema: Schema,
  loc: string[],
  issues: ValidationIssue[],
  resolveRef: (ref: string) => Schema,
): unknown {
  if (typeof schema.$ref === "string") {
    return validateValue(value, resolveRef(schema.$ref), loc, issues, resolveRef);
  }
  const anyOf = schema.anyOf as Schema[] | undefined;
  if (anyOf) {
    if (value === null && anyOf.some((s) => s.type === "null")) return null;
    const option = anyOf.find((s) => s.type !== "null") ?? {};
    return validateValue(value, option, loc, issues, resolveRef);
  }
  try {
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.some((allowed) => allowed === value)) {
        throw new FieldError(`Input should be ${literalList(schema.enum)}`, "literal_error");
      }
      return value;
    }
    switch (schema.type) {
      case "string": {
        if (typeof value !== "string") {
          throw new FieldError("Input should be a valid string", "string_type");
        }
        const { minLength, maxLength } = schema as Record<string, number>;
        if (minLength !== undefined && pyLen(value) < minLength) {
          throw new FieldError(
            `String should have at least ${plural(minLength, "character")}`,
            "string_too_short",
          );
        }
        if (maxLength !== undefined && pyLen(value) > maxLength) {
          throw new FieldError(
            `String should have at most ${plural(maxLength, "character")}`,
            "string_too_long",
          );
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
        if (!Array.isArray(value))
          throw new FieldError("Input should be a valid list", "list_type");
        const itemSchema = (schema.items as Schema | undefined) ?? {};
        const before = issues.length;
        const items = value.map((item, i) =>
          validateValue(item, itemSchema, [...loc, String(i)], issues, resolveRef),
        );
        if (issues.length > before) return undefined;
        const { minItems, maxItems } = schema as Record<string, number>;
        if (minItems !== undefined && items.length < minItems) {
          throw new FieldError(
            `List should have at least ${plural(minItems, "item")} after validation, not ${items.length}`,
            "too_short",
          );
        }
        if (maxItems !== undefined && items.length > maxItems) {
          throw new FieldError(
            `List should have at most ${plural(maxItems, "item")} after validation, not ${items.length}`,
            "too_long",
          );
        }
        return items;
      }
      case "object":
        if (!isDict(value)) throw new FieldError("Input should be a valid dictionary", "dict_type");
        return value;
      default:
        return value;
    }
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    issues.push({ loc, message: error.message, type: error.type });
    return undefined;
  }
}

function defaultFor(schema: Schema): unknown {
  if ("default" in schema) return structuredClone(schema.default);
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return null;
}

export type ObjectValidation = {
  value: Record<string, unknown>;
  /** Fields present in the input (Pydantic's `model_fields_set`, for `exclude_unset`). */
  set: Set<string>;
  issues: ValidationIssue[];
};

/** Validate an object against a Pydantic model schema, filling defaults. */
export function validateObject(
  schema: Schema,
  input: unknown,
  options: ObjectValidationOptions = {},
): ObjectValidation {
  const resolveRef =
    options.resolveRef ??
    (() => {
      throw new Error("Unresolvable $ref");
    });
  const prefix = options.locPrefix ?? [];
  const issues: ValidationIssue[] = [];
  const value: Record<string, unknown> = {};
  const set = new Set<string>();
  if (!isDict(input)) {
    issues.push({
      loc: prefix,
      message: "Input should be a valid dictionary or object to extract fields from",
      type: "model_attributes_type",
    });
    return { value, set, issues };
  }

  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set((schema.required ?? []) as string[]);
  const consumed = new Set<string>();
  for (const [name, property] of Object.entries(properties)) {
    const inputName = (options.aliases?.[name] ?? [name]).find((n) => Object.hasOwn(input, n));
    if (inputName === undefined) {
      if (required.has(name)) {
        issues.push({ loc: [...prefix, name], message: "Field required", type: "missing" });
      } else {
        value[name] = defaultFor(property);
      }
      continue;
    }
    consumed.add(inputName);
    set.add(name);
    const before = issues.length;
    let fieldValue = validateValue(
      input[inputName],
      property,
      [...prefix, name],
      issues,
      resolveRef,
    );
    if (issues.length > before) continue;
    const validator = options.fieldValidators?.[name];
    if (validator) {
      try {
        fieldValue = validator(fieldValue);
      } catch (error) {
        issues.push({
          loc: [...prefix, name],
          message: `Value error, ${(error as Error).message}`,
          type: "value_error",
        });
        continue;
      }
    }
    value[name] = fieldValue;
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(input)) {
      if (!consumed.has(name) && !Object.hasOwn(properties, name)) {
        issues.push({
          loc: [...prefix, name],
          message: "Extra inputs are not permitted",
          type: "extra_forbidden",
        });
      }
    }
  }
  if (issues.length === 0 && options.modelValidator) {
    try {
      options.modelValidator(value);
    } catch (error) {
      issues.push({
        loc: prefix,
        message: `Value error, ${(error as Error).message}`,
        type: "value_error",
      });
    }
  }
  return { value, set, issues };
}
