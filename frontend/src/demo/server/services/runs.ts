/** Port of `app/services/runs.py`: snapshotting configuration at launch, progress, cancel, resume. */

import { retryPolicy } from "../../engine";
import { pyCompare } from "../../engine/py";
import type { Context } from "../context";
import { parseBody } from "../context";
import { newId, orderBy, utcnow, type Row, type TableName } from "../db";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors";
import { byPosition, getSuite } from "./suites";

const RUN_VARIANT_FIELDS = [
  "id",
  "variant_id",
  "position",
  "name",
  "provider",
  "model",
  "system_prompt",
  "user_template",
  "temperature",
  "max_tokens",
  "settings",
];
const RUN_EVALUATOR_FIELDS = [
  "id",
  "evaluator_id",
  "position",
  "name",
  "type",
  "config",
  "regression_threshold",
];

const pick = (row: Row, fields: string[]) => Object.fromEntries(fields.map((f) => [f, row[f]]));

function progress(ctx: Context, runId: string) {
  const counts = { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const result of ctx.db.where("results", "run_id", runId)) {
    counts.total += 1;
    const status = result.status as keyof typeof counts;
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

function getRun(ctx: Context, runId: string): Row {
  const run = ctx.db.get("runs", runId);
  if (!run) throw NotFoundError.forEntity("Run", runId);
  return run;
}

function runOut(ctx: Context, run: Row) {
  const suite = ctx.db.get("eval_suites", run.suite_id as string)!;
  const isBaseline = suite.baseline_run_id === run.id;
  return {
    id: run.id,
    suite_id: run.suite_id,
    suite_name: suite.name,
    name: run.name,
    notes: run.notes,
    status: run.status,
    concurrency: run.concurrency,
    max_attempts: run.max_attempts,
    error: run.error,
    created_at: run.created_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    case_count: ctx.db.where("run_cases", "run_id", run.id).length,
    progress: progress(ctx, run.id),
    is_baseline: isBaseline,
    baseline_run_variant_id: isBaseline ? suite.baseline_run_variant_id : null,
    variants: byPosition(ctx.db.where("run_variants", "run_id", run.id)).map((v) =>
      pick(v, RUN_VARIANT_FIELDS),
    ),
    evaluators: byPosition(ctx.db.where("run_evaluators", "run_id", run.id)).map((e) =>
      pick(e, RUN_EVALUATOR_FIELDS),
    ),
    summary: run.summary,
  };
}

export function listRuns(ctx: Context, suiteId: string | null = null) {
  let runs = ctx.db.rows("runs");
  if (suiteId !== null) {
    getSuite(ctx, suiteId);
    runs = runs.filter((r) => r.suite_id === suiteId);
  }
  return orderBy(runs, "created_at", true).map((r) => runOut(ctx, r));
}

export function getRunDetail(ctx: Context, runId: string) {
  const run = getRun(ctx, runId);
  const tags = new Set(
    ctx.db.where("run_cases", "run_id", runId).flatMap((c) => c.tags as string[]),
  );
  return { ...runOut(ctx, run), execution: run.execution, tags: [...tags].sort(pyCompare) };
}

function requireProvider(ctx: Context, provider: string, context: string): void {
  const info = ctx.providers.find((p) => p.name === provider);
  if (info?.configured) return;
  const reason = info
    ? `Provider '${provider}' is not available in this demo: its results were recorded in advance`
    : `Unknown provider '${provider}'`;
  throw new InvalidRequestError(`${context}: ${reason}`);
}

function selectInOrder(
  ctx: Context,
  table: TableName,
  suiteId: string,
  ids: string[],
  label: string,
): Row[] {
  const byId = new Map(ctx.db.where(table, "suite_id", suiteId).map((row) => [row.id, row]));
  const unique = [...new Set(ids)];
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new InvalidRequestError(`Unknown ${label} for this suite: ${missing.join(", ")}`);
  }
  return unique.map((id) => byId.get(id)!);
}

function executionMetadata(
  ctx: Context,
  variants: Row[],
  evaluators: Row[],
  data: Record<string, unknown>,
  concurrency: number,
) {
  const models = new Set<string>();
  for (const v of variants) models.add(`${v.provider}/${v.model}`);
  for (const e of evaluators) {
    if (e.type === "llm_judge") {
      const config = e.config as Record<string, unknown>;
      models.add(`${config.provider}/${config.model}`);
    }
  }
  const pricing: Record<string, unknown> = {};
  for (const key of [...models].sort(pyCompare)) {
    const [provider, ...model] = key.split("/");
    const price = ctx.pricing.lookup(provider, model.join("/"));
    pricing[key] = price
      ? { input_per_mtok: price.input_per_mtok, output_per_mtok: price.output_per_mtok }
      : null;
  }
  return {
    app_version: "0.1.0",
    runtime: "in-browser demo",
    concurrency,
    retry_policy: retryPolicy(data.max_attempts as number),
    selection: { test_case_ids: data.test_case_ids, tags: data.tags },
    pricing,
  };
}

export function createRun(ctx: Context, suiteId: string, body: unknown) {
  const { value: data } = parseBody("RunCreate", body);
  const suite = getSuite(ctx, suiteId);
  const variants = selectInOrder(
    ctx,
    "variants",
    suiteId,
    data.variant_ids as string[],
    "variants",
  );
  const evaluators = selectInOrder(
    ctx,
    "evaluators",
    suiteId,
    data.evaluator_ids as string[],
    "evaluators",
  );

  let cases = orderBy(ctx.db.where("test_cases", "suite_id", suiteId), "created_at");
  const wantedIds = data.test_case_ids as string[] | null;
  if (wantedIds !== null) {
    const wanted = new Set(wantedIds);
    const unknown = [...wanted].filter((id) => !cases.some((c) => c.id === id)).sort(pyCompare);
    if (unknown.length) throw new InvalidRequestError(`Unknown test cases: ${unknown.join(", ")}`);
    cases = cases.filter((c) => wanted.has(c.id));
  }
  const tags = data.tags as string[] | null;
  if (tags && tags.length) {
    cases = cases.filter((c) => (c.tags as string[]).some((t) => tags.includes(t)));
  }
  if (cases.length === 0) throw new InvalidRequestError("The selection contains no test cases");

  for (const variant of variants)
    requireProvider(ctx, variant.provider as string, `Variant '${variant.name}'`);
  for (const evaluator of evaluators) {
    if (evaluator.type === "llm_judge") {
      const provider = (evaluator.config as Record<string, unknown>).provider as string;
      requireProvider(ctx, provider, `Judge '${evaluator.name}'`);
    }
  }

  const concurrency = (data.concurrency as number | null) || ctx.settings.default_concurrency;
  if (concurrency > ctx.settings.max_concurrency) {
    throw new InvalidRequestError(
      `Concurrency ${concurrency} exceeds the maximum of ${ctx.settings.max_concurrency}`,
    );
  }

  const runCount = ctx.db.where("runs", "suite_id", suiteId).length;
  const run = ctx.db.insert("runs", {
    id: newId("run"),
    suite_id: suite.id,
    name: (data.name as string | null) || `Run ${runCount + 1}`,
    notes: data.notes,
    status: "queued",
    concurrency,
    max_attempts: data.max_attempts,
    error: null,
    execution: executionMetadata(ctx, variants, evaluators, data, concurrency),
    summary: null,
    created_at: utcnow(),
    started_at: null,
    finished_at: null,
  });
  const runCases = cases.map((c, i) =>
    ctx.db.insert("run_cases", {
      id: newId("rc"),
      run_id: run.id,
      test_case_id: c.id,
      position: i,
      key: c.key,
      input: structuredClone(c.input),
      expected: structuredClone(c.expected),
      tags: [...(c.tags as string[])],
      metadata: structuredClone(c.metadata),
    }),
  );
  const runVariants = variants.map((v, i) =>
    ctx.db.insert("run_variants", {
      id: newId("rv"),
      run_id: run.id,
      variant_id: v.id,
      position: i,
      name: v.name,
      provider: v.provider,
      model: v.model,
      system_prompt: v.system_prompt,
      user_template: v.user_template,
      temperature: v.temperature,
      max_tokens: v.max_tokens,
      settings: structuredClone(v.settings),
    }),
  );
  evaluators.forEach((e, i) =>
    ctx.db.insert("run_evaluators", {
      id: newId("re"),
      run_id: run.id,
      evaluator_id: e.id,
      position: i,
      name: e.name,
      type: e.type,
      config: structuredClone(e.config),
      regression_threshold: e.regression_threshold,
    }),
  );
  for (const rc of runCases) {
    for (const rv of runVariants) {
      ctx.db.insert("results", {
        id: newId("res"),
        run_id: run.id,
        run_case_id: rc.id,
        run_variant_id: rv.id,
        status: "pending",
        output: null,
        request_messages: null,
        response_model: null,
        latency_ms: null,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        attempts: 0,
        error_type: null,
        error_message: null,
        started_at: null,
        finished_at: null,
      });
    }
  }
  ctx.manager.start(run.id);
  return getRunDetail(ctx, run.id);
}

export async function deleteRun(ctx: Context, runId: string): Promise<void> {
  getRun(ctx, runId);
  if (ctx.manager.isActive(runId)) throw new ConflictError("Cancel the run before deleting it");
  ctx.db.delete("runs", (row) => row.id === runId);
}

export async function cancelRun(ctx: Context, runId: string) {
  const run = getRun(ctx, runId);
  if (await ctx.manager.cancel(runId)) return getRunDetail(ctx, runId);
  if (run.status === "queued" || run.status === "running") {
    // Queued but never picked up (or orphaned): settle it directly.
    for (const result of ctx.db.where("results", "run_id", runId)) {
      if (result.status === "pending" || result.status === "running") result.status = "cancelled";
    }
    run.status = "cancelled";
    ctx.db.changed();
    return getRunDetail(ctx, runId);
  }
  throw new ConflictError(`Run is already ${run.status}`);
}

export function resumeRun(ctx: Context, runId: string, body: unknown) {
  const { value } = parseBody("ResumeRequest", body);
  const run = getRun(ctx, runId);
  if (ctx.manager.isActive(runId)) throw new ConflictError("Run is already executing");
  const reset = new Set(["cancelled", "pending", "running"]);
  if (value.retry_failed) reset.add("failed");
  const results = ctx.db
    .where("results", "run_id", runId)
    .filter((r) => reset.has(r.status as string));
  if (results.length === 0) {
    throw new ConflictError("Nothing to resume: every generation has already completed");
  }
  const ids = new Set(results.map((r) => r.id));
  ctx.db.delete("evaluator_scores", (s) => ids.has(s.result_id as string));
  for (const result of results) {
    Object.assign(result, {
      status: "pending",
      output: null,
      error_type: null,
      error_message: null,
      attempts: 0,
      latency_ms: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      started_at: null,
      finished_at: null,
    });
  }
  run.status = "queued";
  run.error = null;
  ctx.db.changed();
  ctx.manager.start(runId);
  return getRunDetail(ctx, runId);
}
