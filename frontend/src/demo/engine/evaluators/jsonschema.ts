/**
 * JSON Schema (draft 2020-12) validation with the Python `jsonschema` library's messages.
 *
 * Validation itself is done by ajv; its errors are translated into jsonschema's wording and
 * ordered the way the backend orders them (by instance path, then by keyword position in the
 * schema), so schema-violation reasons read the same in the demo as in the real app.
 */

import Ajv2020, { type ErrorObject } from "ajv/dist/2020";

import { isDict, pyCompare, pyFloatRepr, pyNumberRepr, pyRepr } from "../py";

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

/** `repr()` of a JSON value. */
export function pyReprValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumberRepr(value);
  if (typeof value === "string") return pyRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyReprValue).join(", ")}]`;
  if (isDict(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyRepr(k)}: ${pyReprValue(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

function at(root: unknown, pointer: string): unknown {
  let current = root;
  for (const raw of pointer.split("/").slice(1)) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)?.[part];
  }
  return current;
}

function limit(value: unknown): string {
  return typeof value === "number" && !Number.isInteger(value) ? pyFloatRepr(value) : String(value);
}

function message(error: ErrorObject, instance: unknown): string {
  const shown = pyReprValue(instance);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "type": {
      const types = Array.isArray(params.type) ? params.type : String(params.type).split(",");
      return `${shown} is not of type ${types.map((t) => pyRepr(String(t))).join(", ")}`;
    }
    case "required":
      return `${pyRepr(String(params.missingProperty))} is a required property`;
    case "minimum":
      return `${shown} is less than the minimum of ${limit(params.limit)}`;
    case "maximum":
      return `${shown} is greater than the maximum of ${limit(params.limit)}`;
    case "exclusiveMinimum":
      return `${shown} is less than or equal to the minimum of ${limit(params.limit)}`;
    case "exclusiveMaximum":
      return `${shown} is greater than or equal to the maximum of ${limit(params.limit)}`;
    case "minLength":
    case "minItems":
      return `${shown} ${params.limit === 1 ? "should be non-empty" : "is too short"}`;
    case "maxLength":
    case "maxItems":
      return `${shown} is too long`;
    case "enum":
      return `${shown} is not one of ${pyReprValue(params.allowedValues)}`;
    case "const":
      return `${pyReprValue(params.allowedValue)} was expected`;
    case "pattern":
      return `${shown} does not match ${pyRepr(String(params.pattern))}`;
    case "multipleOf":
      return `${shown} is not a multiple of ${limit(params.multipleOf)}`;
    case "uniqueItems":
      return `${shown} has non-unique elements`;
    default:
      return `${shown}: ${error.message ?? "is invalid"}`;
  }
}

type Violation = { path: string[]; rank: number; text: string };

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = pyCompare(a[i], b[i]);
    if (diff) return diff;
  }
  return a.length - b.length;
}

export class SchemaValidator {
  private readonly validate: ReturnType<typeof ajv.compile>;

  constructor(private readonly schema: Record<string, unknown>) {
    this.validate = ajv.compile(schema);
  }

  /** Violation messages formatted like the backend: `path: message`, `(root)` at the top. */
  violations(instance: unknown): string[] {
    if (this.validate(instance)) return [];
    const found: Violation[] = [];
    const extras = new Map<string, { path: string[]; rank: number; names: string[] }>();
    for (const error of this.validate.errors ?? []) {
      const path = error.instancePath.split("/").slice(1);
      const keywordPath = error.schemaPath.replace(/^#/, "").split("/");
      const keyword = keywordPath.pop()!;
      const parent = at(this.schema, keywordPath.join("/"));
      const rank = isDict(parent) ? Object.keys(parent).indexOf(keyword) : 0;
      if (error.keyword === "additionalProperties") {
        const key = error.instancePath;
        const entry = extras.get(key) ?? { path, rank, names: [] };
        entry.names.push(String((error.params as Record<string, unknown>).additionalProperty));
        extras.set(key, entry);
        continue;
      }
      found.push({ path, rank, text: message(error, at(instance, error.instancePath)) });
    }
    for (const { path, rank, names } of extras.values()) {
      const sorted = [...names].sort(pyCompare).map(pyRepr).join(", ");
      const verb = names.length === 1 ? "was" : "were";
      found.push({
        path,
        rank,
        text: `Additional properties are not allowed (${sorted} ${verb} unexpected)`,
      });
    }
    found.sort((a, b) => comparePaths(a.path, b.path) || a.rank - b.rank);
    return found.map((v) => `${v.path.join("/") || "(root)"}: ${v.text}`);
  }
}

/** Throws with a readable message when the schema itself is invalid. */
export function checkSchema(schema: unknown): void {
  if (!ajv.validateSchema(schema as object)) {
    const first = ajv.errors?.[0];
    const where = first?.instancePath ? ` at ${first.instancePath}` : "";
    throw new Error(`${first?.message ?? "invalid schema"}${where}`);
  }
  try {
    ajv.compile(schema as object);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
