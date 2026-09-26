/** Ports of `app/services/variants.py` and `app/services/evaluators.py`. */

import { InvalidEvaluatorConfig, templateVariables } from "../../engine";
import type { Context } from "../context";
import { knownProviders, parseBody } from "../context";
import { newId, orderBy, utcnow, type Row, type TableName } from "../db";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors";
import { getSuite } from "./suites";

// --- variants --------------------------------------------------------------------------------

const VARIANT_FIELDS = [
  "name",
  "description",
  "provider",
  "model",
  "system_prompt",
  "user_template",
  "temperature",
  "max_tokens",
  "settings",
] as const;

export function variantOut(row: Row) {
  return {
    ...Object.fromEntries(VARIANT_FIELDS.map((f) => [f, row[f]])),
    id: row.id,
    suite_id: row.suite_id,
    template_variables: templateVariables(row.user_template as string),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function checkProvider(ctx: Context, provider: string): void {
  const known = knownProviders(ctx);
  if (!known.includes(provider)) {
    throw new InvalidRequestError(`Unknown provider '${provider}'. Available: ${known.join(", ")}`);
  }
}

function ensureNameAvailable(
  ctx: Context,
  table: TableName,
  label: string,
  suiteId: string,
  name: string,
  excludeId?: string,
): void {
  const clash = ctx.db
    .where(table, "suite_id", suiteId)
    .some((r) => r.name === name && r.id !== excludeId);
  if (clash) throw new ConflictError(`${label} named '${name}' already exists in this suite`);
}

function getRow(ctx: Context, table: TableName, entity: string, id: string): Row {
  const row = ctx.db.get(table, id);
  if (!row) throw NotFoundError.forEntity(entity, id);
  return row;
}

export function listVariants(ctx: Context, suiteId: string) {
  getSuite(ctx, suiteId);
  return orderBy(ctx.db.where("variants", "suite_id", suiteId), "created_at").map(variantOut);
}

export function createVariant(ctx: Context, suiteId: string, body: unknown) {
  const { value } = parseBody("VariantCreate", body);
  getSuite(ctx, suiteId);
  checkProvider(ctx, value.provider as string);
  ensureNameAvailable(ctx, "variants", "A variant", suiteId, value.name as string);
  const now = utcnow();
  const row = ctx.db.insert("variants", {
    id: newId("var"),
    suite_id: suiteId,
    ...Object.fromEntries(VARIANT_FIELDS.map((f) => [f, value[f]])),
    created_at: now,
    updated_at: now,
  });
  return variantOut(row);
}

export function updateVariant(ctx: Context, variantId: string, body: unknown) {
  const { value, set } = parseBody("VariantUpdate", body);
  const row = getRow(ctx, "variants", "Variant", variantId);
  if (set.has("provider") && value.provider !== null) checkProvider(ctx, value.provider as string);
  if (set.has("name") && value.name !== null) {
    ensureNameAvailable(
      ctx,
      "variants",
      "A variant",
      row.suite_id as string,
      value.name as string,
      row.id,
    );
  }
  for (const field of set) {
    // temperature may be explicitly cleared; other fields ignore nulls.
    if (value[field] !== null || field === "temperature") row[field] = value[field];
  }
  if (set.size) row.updated_at = utcnow();
  ctx.db.changed();
  return variantOut(row);
}

export function deleteVariant(ctx: Context, variantId: string): void {
  getRow(ctx, "variants", "Variant", variantId);
  ctx.db.delete("variants", (row) => row.id === variantId);
}

// --- evaluators ------------------------------------------------------------------------------

export function evaluatorOut(row: Row) {
  return {
    name: row.name,
    type: row.type,
    config: row.config,
    regression_threshold: row.regression_threshold,
    id: row.id,
    suite_id: row.suite_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validatedConfig(ctx: Context, type: string, config: unknown): Record<string, unknown> {
  let normalized: Record<string, unknown>;
  try {
    normalized = ctx.registry.normalizeConfig(type, config);
  } catch (error) {
    if (error instanceof InvalidEvaluatorConfig) {
      throw new InvalidRequestError(error.message, error.errors);
    }
    throw error;
  }
  const known = knownProviders(ctx);
  if (type === "llm_judge" && !known.includes(normalized.provider as string)) {
    throw new InvalidRequestError(
      `Unknown judge provider '${normalized.provider}'. Available: ${known.join(", ")}`,
    );
  }
  return normalized;
}

export function listEvaluators(ctx: Context, suiteId: string) {
  getSuite(ctx, suiteId);
  return orderBy(ctx.db.where("evaluators", "suite_id", suiteId), "created_at").map(evaluatorOut);
}

export function createEvaluator(ctx: Context, suiteId: string, body: unknown) {
  const { value } = parseBody("EvaluatorCreate", body);
  getSuite(ctx, suiteId);
  ensureNameAvailable(ctx, "evaluators", "An evaluator", suiteId, value.name as string);
  const config = validatedConfig(ctx, value.type as string, value.config);
  const now = utcnow();
  const row = ctx.db.insert("evaluators", {
    id: newId("eval"),
    suite_id: suiteId,
    name: value.name,
    type: value.type,
    config,
    regression_threshold: value.regression_threshold,
    created_at: now,
    updated_at: now,
  });
  return evaluatorOut(row);
}

/** The evaluator type is immutable; create a new evaluator to change what is measured. */
export function updateEvaluator(ctx: Context, evaluatorId: string, body: unknown) {
  const { value } = parseBody("EvaluatorUpdate", body);
  const row = getRow(ctx, "evaluators", "Evaluator", evaluatorId);
  if (value.name !== null) {
    ensureNameAvailable(
      ctx,
      "evaluators",
      "An evaluator",
      row.suite_id as string,
      value.name as string,
      row.id,
    );
    row.name = value.name;
  }
  if (value.config !== null) row.config = validatedConfig(ctx, row.type as string, value.config);
  if (value.regression_threshold !== null) row.regression_threshold = value.regression_threshold;
  row.updated_at = utcnow();
  ctx.db.changed();
  return evaluatorOut(row);
}

export function deleteEvaluator(ctx: Context, evaluatorId: string): void {
  getRow(ctx, "evaluators", "Evaluator", evaluatorId);
  ctx.db.delete("evaluators", (row) => row.id === evaluatorId);
}
