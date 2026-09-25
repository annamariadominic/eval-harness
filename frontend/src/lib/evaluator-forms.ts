/**
 * Form definitions for each evaluator type. The server validates and normalises every config
 * (see backend app/evaluators/registry.py); this module only describes how to edit one and how
 * to summarise one in a sentence.
 */

export type FieldKind =
  "text" | "textarea" | "list" | "bool" | "number" | "select" | "json" | "provider";

export type FieldSpec = {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  options?: string[];
  step?: number;
  optional?: boolean;
};

export const EVALUATOR_FIELDS: Record<string, FieldSpec[]> = {
  exact_match: [
    {
      key: "expected_path",
      label: "Expected field",
      kind: "text",
      optional: true,
      hint: "e.g. answer. Empty compares the whole expected output.",
    },
    {
      key: "output_path",
      label: "Output JSON field",
      kind: "text",
      optional: true,
      hint: "Parse the output as JSON and compare this field.",
    },
    { key: "case_sensitive", label: "Case sensitive", kind: "bool" },
    { key: "collapse_whitespace", label: "Ignore whitespace differences", kind: "bool" },
  ],
  contains: [
    { key: "values", label: "Must contain", kind: "list", hint: "One value per line." },
    {
      key: "expected_path",
      label: "Also look for expected field",
      kind: "text",
      optional: true,
      hint: "e.g. answer",
    },
    { key: "mode", label: "Match", kind: "select", options: ["all", "any"] },
    { key: "case_sensitive", label: "Case sensitive", kind: "bool" },
  ],
  regex: [
    { key: "pattern", label: "Pattern", kind: "text", hint: "Python regular expression syntax." },
    { key: "should_match", label: "Output should match (uncheck to forbid)", kind: "bool" },
    { key: "ignore_case", label: "Ignore case", kind: "bool" },
    { key: "multiline", label: "Multiline", kind: "bool" },
    { key: "dotall", label: "Dot matches newline", kind: "bool" },
  ],
  json_valid: [
    { key: "allow_code_fence", label: "Accept JSON inside a markdown code fence", kind: "bool" },
  ],
  json_schema: [
    { key: "json_schema", label: "JSON Schema", kind: "json", hint: "Draft 2020-12." },
    { key: "allow_code_fence", label: "Accept JSON inside a markdown code fence", kind: "bool" },
  ],
  required_fields: [
    {
      key: "fields",
      label: "Required fields",
      kind: "list",
      hint: "One dotted path per line, e.g. company or items[0].name.",
    },
    { key: "allow_null", label: "Allow null values", kind: "bool" },
    { key: "allow_code_fence", label: "Accept JSON inside a markdown code fence", kind: "bool" },
  ],
  field_match: [
    {
      key: "fields",
      label: "Fields to compare",
      kind: "list",
      optional: true,
      hint: "Empty compares every top-level field of the expected output.",
    },
    {
      key: "numeric_tolerance",
      label: "Numeric tolerance",
      kind: "number",
      step: 0.001,
      hint: "Relative, e.g. 0.01 allows a 1% difference.",
    },
    {
      key: "pass_threshold",
      label: "Pass threshold",
      kind: "number",
      step: 0.05,
      hint: "Share of fields that must match (0-1).",
    },
    { key: "case_sensitive", label: "Case sensitive strings", kind: "bool" },
    { key: "allow_code_fence", label: "Accept JSON inside a markdown code fence", kind: "bool" },
  ],
  llm_judge: [
    {
      key: "criteria",
      label: "Rubric",
      kind: "textarea",
      hint: "What the judge should check. Be specific about what earns or loses points.",
    },
    { key: "provider", label: "Judge provider", kind: "provider" },
    { key: "model", label: "Judge model", kind: "text" },
    { key: "score_min", label: "Score from", kind: "number", step: 1 },
    { key: "score_max", label: "Score to", kind: "number", step: 1 },
    {
      key: "pass_threshold",
      label: "Pass threshold",
      kind: "number",
      step: 0.05,
      hint: "Normalised 0-1. 0.75 on a 1-5 scale means 4 or higher.",
    },
    { key: "include_input", label: "Show the judge the test input", kind: "bool" },
    { key: "include_expected", label: "Show the judge the expected output", kind: "bool" },
  ],
};

export const DEFAULT_CONFIGS: Record<string, Record<string, unknown>> = {
  exact_match: {
    expected_path: null,
    output_path: null,
    case_sensitive: true,
    collapse_whitespace: true,
  },
  contains: { values: [], expected_path: null, mode: "all", case_sensitive: false },
  regex: { pattern: "", should_match: true, ignore_case: false, multiline: false, dotall: false },
  json_valid: { allow_code_fence: false },
  json_schema: {
    json_schema: { type: "object", properties: {}, required: [] },
    allow_code_fence: false,
  },
  required_fields: { fields: [], allow_null: false, allow_code_fence: false },
  field_match: {
    fields: null,
    numeric_tolerance: 0,
    case_sensitive: false,
    pass_threshold: 1,
    allow_code_fence: false,
  },
  llm_judge: {
    provider: "mock",
    model: "mock-large",
    criteria: "",
    score_min: 1,
    score_max: 5,
    pass_threshold: 0.75,
    include_input: true,
    include_expected: true,
  },
};

type Config = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

/** One-line, human-readable description of what an evaluator checks. */
export function describeEvaluator(type: string, config: Config): string {
  switch (type) {
    case "exact_match":
      return `Equals expected${config.expected_path ? ` "${str(config.expected_path)}"` : ""}${config.case_sensitive ? "" : ", ignoring case"}`;
    case "contains": {
      const values = list(config.values);
      const parts = values.length ? values.map((v) => `"${v}"`).join(", ") : "";
      const fromExpected = config.expected_path ? `expected "${str(config.expected_path)}"` : "";
      return `Contains ${config.mode === "any" ? "any of" : "all of"} ${[parts, fromExpected].filter(Boolean).join(" + ") || "the expected output"}`;
    }
    case "regex":
      return `${config.should_match === false ? "Must not match" : "Matches"} /${str(config.pattern)}/`;
    case "json_valid":
      return "Output parses as JSON";
    case "json_schema": {
      const required = list((config.json_schema as Config | undefined)?.required);
      return `Conforms to a JSON Schema${required.length ? ` requiring ${required.join(", ")}` : ""}`;
    }
    case "required_fields":
      return `Has ${list(config.fields).join(", ")}`;
    case "field_match": {
      const fields = list(config.fields);
      const tolerance = Number(config.numeric_tolerance ?? 0);
      return `Compares ${fields.length ? fields.join(", ") : "every expected field"}${tolerance ? ` within ${tolerance * 100}%` : ""}`;
    }
    case "llm_judge":
      return `${str(config.provider)}/${str(config.model)} scores ${config.score_min}-${config.score_max}, passes at ${Math.round(Number(config.pass_threshold) * 100)}%`;
    default:
      return type;
  }
}

/** Convert list fields edited as multi-line text back into arrays (or null when optional). */
export function listFromText(text: string, optional: boolean): string[] | null {
  const items = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return items.length === 0 && optional ? null : items;
}
