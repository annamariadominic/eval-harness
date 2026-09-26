/** Port of `app/services/test_cases.py`: test case CRUD and JSON import. */

import { pyCasefold, pyEq, pySplit, pyStrip } from "../../engine/py";
import { dumps } from "../../engine/pyjson";
import { validateObject } from "../../engine/validation";
import openapi from "@/lib/api/openapi.json";
import type { Context } from "../context";
import { parseBody } from "../context";
import { newId, orderBy, utcnow, type Row } from "../db";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors";
import { getSuite } from "./suites";

const IMPORT_FIELDS = ["expected", "input", "key", "metadata", "tags"];
const ALLOWED_FIELDS_TEXT = IMPORT_FIELDS.join(", ");
const PREVIEW_LIMIT = 50;

/** Trim, lowercase, and de-duplicate tags while preserving order. */
export function normalizeTags(tags: string[]): string[] {
  const seen: string[] = [];
  for (const tag of tags) {
    const cleaned = pySplit(tag.toLowerCase()).join("-");
    if (cleaned && !seen.includes(cleaned)) seen.push(cleaned);
  }
  return seen;
}

const isEmptyInput = (value: unknown) => value === null || value === "" || pyEq(value, {});

/** `TestCaseCreate` field validators. */
const CREATE_VALIDATORS = {
  input: (value: unknown) => {
    if (isEmptyInput(value)) throw new Error("input must not be empty");
    return value;
  },
  tags: (value: unknown) => normalizeTags(value as string[]),
  key: (value: unknown) => (value === null ? null : pyStrip(value as string) || null),
};

const CREATE_OPTIONS = {
  fieldValidators: CREATE_VALIDATORS,
  aliases: { meta: ["meta", "metadata"] },
};

export function caseOut(row: Row) {
  return {
    key: row.key,
    input: row.input,
    expected: row.expected,
    tags: row.tags,
    metadata: row.metadata,
    id: row.id,
    suite_id: row.suite_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getCase(ctx: Context, caseId: string): Row {
  const row = ctx.db.get("test_cases", caseId);
  if (!row) throw NotFoundError.forEntity("TestCase", caseId);
  return row;
}

export function getTestCase(ctx: Context, caseId: string) {
  return caseOut(getCase(ctx, caseId));
}

export function listTestCases(
  ctx: Context,
  suiteId: string,
  tag: string | null = null,
  search: string | null = null,
) {
  getSuite(ctx, suiteId);
  let cases = orderBy(ctx.db.where("test_cases", "suite_id", suiteId), "created_at");
  if (tag) cases = cases.filter((c) => (c.tags as string[]).includes(tag));
  if (search) {
    const needle = pyCasefold(search);
    const text = (value: unknown) => pyCasefold(dumps(value, { ensureAscii: false }));
    cases = cases.filter(
      (c) =>
        pyCasefold((c.key as string | null) ?? "").includes(needle) ||
        text(c.input).includes(needle) ||
        text(c.expected).includes(needle),
    );
  }
  return cases.map(caseOut);
}

function ensureKeyAvailable(ctx: Context, suiteId: string, key: string | null, excludeId?: string) {
  if (key === null) return;
  const clash = ctx.db
    .where("test_cases", "suite_id", suiteId)
    .some((c) => c.key === key && c.id !== excludeId);
  if (clash) throw new ConflictError(`A test case with key '${key}' already exists in this suite`);
}

function insertCase(ctx: Context, suiteId: string, data: Record<string, unknown>): Row {
  const now = utcnow();
  return ctx.db.insert("test_cases", {
    id: newId("case"),
    suite_id: suiteId,
    key: data.key ?? null,
    input: data.input,
    expected: data.expected ?? null,
    tags: data.tags ?? [],
    metadata: data.meta ?? {},
    created_at: now,
    updated_at: now,
  });
}

export function createTestCase(ctx: Context, suiteId: string, body: unknown) {
  const { value } = parseBody("TestCaseCreate-Input", body, CREATE_OPTIONS);
  getSuite(ctx, suiteId);
  ensureKeyAvailable(ctx, suiteId, value.key as string | null);
  return caseOut(insertCase(ctx, suiteId, value));
}

export function updateTestCase(ctx: Context, caseId: string, body: unknown) {
  const { value, set } = parseBody("TestCaseUpdate", body, {
    fieldValidators: { tags: (v) => (v === null ? null : normalizeTags(v as string[])) },
  });
  const row = getCase(ctx, caseId);
  if (set.has("input") && isEmptyInput(value.input)) {
    throw new InvalidRequestError("input must not be empty");
  }
  if (set.has("key")) {
    const key = pyStrip((value.key as string | null) ?? "") || null;
    ensureKeyAvailable(ctx, row.suite_id as string, key, row.id);
    row.key = key;
  }
  if (set.has("input")) row.input = value.input;
  if (set.has("expected")) row.expected = value.expected;
  if (set.has("tags") && value.tags !== null) row.tags = value.tags;
  if (set.has("metadata") && value.metadata !== null) row.metadata = value.metadata;
  if (set.size) row.updated_at = utcnow();
  ctx.db.changed();
  return caseOut(row);
}

export function deleteTestCase(ctx: Context, caseId: string): void {
  getCase(ctx, caseId);
  ctx.db.delete("test_cases", (row) => row.id === caseId);
}

// --- import ----------------------------------------------------------------------------------

type ImportIssue = { index: number; field: string; message: string };

const createSchema = (openapi.components.schemas as Record<string, unknown>)[
  "TestCaseCreate-Input"
] as Record<string, unknown>;

/** Validate every item, collecting all problems instead of stopping at the first. */
export function validateImport(
  rawCases: unknown[],
  existingKeys: Set<string>,
): [Array<Record<string, unknown>>, ImportIssue[]] {
  const parsed: Array<Record<string, unknown>> = [];
  const issues: ImportIssue[] = [];
  const seenKeys = new Map<string, number>();
  rawCases.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      issues.push({ index, field: "", message: "Each case must be an object" });
      return;
    }
    const unknown = Object.keys(raw)
      .filter((k) => !IMPORT_FIELDS.includes(k))
      .sort();
    for (const field of unknown) {
      issues.push({
        index,
        field,
        message: `Unknown field '${field}'. Allowed: ${ALLOWED_FIELDS_TEXT}`,
      });
    }
    const { value, issues: errors } = validateObject(createSchema, raw, CREATE_OPTIONS);
    if (errors.length) {
      for (const error of errors) {
        issues.push({ index, field: error.loc.join(".") || "(case)", message: error.message });
      }
      return;
    }
    const key = value.key as string | null;
    if (key !== null) {
      if (seenKeys.has(key)) {
        issues.push({
          index,
          field: "key",
          message: `Duplicate key '${key}' (first used by case ${seenKeys.get(key)})`,
        });
      } else if (existingKeys.has(key)) {
        issues.push({ index, field: "key", message: `Key '${key}' already exists in this suite` });
      }
      if (!seenKeys.has(key)) seenKeys.set(key, index);
    }
    parsed.push(value);
  });
  return [parsed, issues];
}

export function importTestCases(ctx: Context, suiteId: string, body: unknown) {
  const { value } = parseBody("DatasetImportRequest", body);
  getSuite(ctx, suiteId);
  const cases = value.cases as unknown[];
  const mode = value.mode as "append" | "replace";
  const dryRun = value.dry_run as boolean;
  if (cases.length === 0) throw new InvalidRequestError("The import contains no test cases");

  const existing = ctx.db.where("test_cases", "suite_id", suiteId);
  const existingKeys =
    mode === "replace"
      ? new Set<string>()
      : new Set(existing.map((c) => c.key).filter((k): k is string => typeof k === "string"));
  const [parsed, issues] = validateImport(cases, existingKeys);
  const valid = issues.length === 0;
  const counts = new Map<string, number>();
  for (const c of parsed) {
    for (const tag of c.tags as string[]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }

  let created = 0;
  let replaced = 0;
  if (valid && !dryRun) {
    if (mode === "replace") {
      replaced = existing.length;
      ctx.db.delete("test_cases", (row) => row.suite_id === suiteId);
    }
    for (const c of parsed) insertCase(ctx, suiteId, c);
    created = parsed.length;
  }

  return {
    valid,
    dry_run: dryRun,
    mode,
    total: cases.length,
    created,
    replaced,
    errors: issues,
    preview: parsed.slice(0, PREVIEW_LIMIT).map((c) => ({
      key: c.key,
      input: c.input,
      expected: c.expected,
      tags: c.tags,
      metadata: c.meta,
    })),
    tag_counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
  };
}
