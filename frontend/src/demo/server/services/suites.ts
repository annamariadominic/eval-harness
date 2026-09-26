/** Port of `app/services/suites.py`: suite CRUD and dashboard summaries. */

import type { Context } from "../context";
import { parseBody } from "../context";
import { newId, orderBy, utcnow, type Row } from "../db";
import { InvalidRequestError, NotFoundError } from "../errors";

type ArmScore = {
  run_id: string;
  run_name: string;
  run_variant_id: string;
  variant_name: string;
  overall_score: number | null;
  pass_rate: number | null;
};

export function getSuite(ctx: Context, suiteId: string): Row {
  const suite = ctx.db.get("eval_suites", suiteId);
  if (!suite) throw NotFoundError.forEntity("Suite", suiteId);
  return suite;
}

export function byPosition<T extends Row>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.position as number) - (b.position as number));
}

function runVariants(ctx: Context, runId: string): Row[] {
  return byPosition(ctx.db.where("run_variants", "run_id", runId));
}

export function armScore(ctx: Context, run: Row, runVariantId: string): ArmScore | null {
  const variant = runVariants(ctx, run.id).find((v) => v.id === runVariantId);
  if (!variant) return null;
  const summary = (run.summary ?? {}) as { arms?: Record<string, Record<string, unknown>> };
  const metrics = summary.arms?.[runVariantId] ?? {};
  return {
    run_id: run.id,
    run_name: run.name as string,
    run_variant_id: variant.id,
    variant_name: variant.name as string,
    overall_score: (metrics.overall_score as number | null | undefined) ?? null,
    pass_rate: (metrics.pass_rate as number | null | undefined) ?? null,
  };
}

/** The highest-scoring variant in a finished run (the run's headline number). */
export function bestArm(ctx: Context, run: Row): ArmScore | null {
  const scored = runVariants(ctx, run.id)
    .map((v) => armScore(ctx, run, v.id))
    .filter((a): a is ArmScore => a !== null && a.overall_score !== null);
  let best: ArmScore | null = null;
  for (const arm of scored) {
    if (best === null || (arm.overall_score ?? 0) > (best.overall_score ?? 0)) best = arm;
  }
  return best;
}

function summarize(ctx: Context, suite: Row) {
  const runs = orderBy(ctx.db.where("runs", "suite_id", suite.id), "created_at", true);
  const latest = runs[0];
  const latestRun = latest
    ? {
        id: latest.id,
        name: latest.name,
        status: latest.status,
        created_at: latest.created_at,
        best: bestArm(ctx, latest),
      }
    : null;

  let baseline: ArmScore | null = null;
  if (suite.baseline_run_id && suite.baseline_run_variant_id) {
    const baselineRun = runs.find((r) => r.id === suite.baseline_run_id);
    if (baselineRun) baseline = armScore(ctx, baselineRun, suite.baseline_run_variant_id as string);
  }

  let delta: number | null = null;
  const scoredRun = runs.find((r) => r.summary && Object.keys(r.summary).length > 0);
  if (baseline && scoredRun && scoredRun.id !== suite.baseline_run_id) {
    const best = bestArm(ctx, scoredRun);
    if (best && best.overall_score !== null && baseline.overall_score !== null) {
      delta = best.overall_score - baseline.overall_score;
    }
  }

  return {
    id: suite.id,
    name: suite.name,
    description: suite.description,
    test_case_count: ctx.db.where("test_cases", "suite_id", suite.id).length,
    variant_count: ctx.db.where("variants", "suite_id", suite.id).length,
    evaluator_count: ctx.db.where("evaluators", "suite_id", suite.id).length,
    run_count: runs.length,
    latest_run: latestRun,
    baseline,
    delta_vs_baseline: delta,
    created_at: suite.created_at,
    updated_at: suite.updated_at,
  };
}

export function listSuites(ctx: Context) {
  return orderBy(ctx.db.rows("eval_suites"), "created_at").map((s) => summarize(ctx, s));
}

export function getSuiteDetail(ctx: Context, suiteId: string) {
  const suite = getSuite(ctx, suiteId);
  const counts = new Map<string, number>();
  for (const testCase of ctx.db.where("test_cases", "suite_id", suiteId)) {
    for (const tag of testCase.tags as string[]) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  // Counter.most_common(): by count, ties in first-seen order.
  const tagCounts = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  return { ...summarize(ctx, suite), tag_counts: tagCounts };
}

export function createSuite(ctx: Context, body: unknown) {
  const { value } = parseBody("SuiteCreate", body);
  const now = utcnow();
  const suite = ctx.db.insert("eval_suites", {
    id: newId("suite"),
    name: value.name,
    description: value.description,
    baseline_run_id: null,
    baseline_run_variant_id: null,
    created_at: now,
    updated_at: now,
  });
  return getSuiteDetail(ctx, suite.id);
}

export function updateSuite(ctx: Context, suiteId: string, body: unknown) {
  const { value, set } = parseBody("SuiteUpdate", body);
  const suite = getSuite(ctx, suiteId);
  let changed = false;
  for (const field of set) {
    if (value[field] !== null && suite[field] !== value[field]) {
      suite[field] = value[field];
      changed = true;
    }
  }
  if (changed) {
    suite.updated_at = utcnow();
    ctx.db.changed();
  }
  return getSuiteDetail(ctx, suiteId);
}

export function deleteSuite(ctx: Context, suiteId: string): void {
  getSuite(ctx, suiteId);
  for (const run of ctx.db.where("runs", "suite_id", suiteId)) ctx.manager.cancel(run.id);
  ctx.db.delete("eval_suites", (row) => row.id === suiteId);
}

export function setBaseline(ctx: Context, suiteId: string, body: unknown) {
  const { value } = parseBody("BaselineUpdate", body);
  const suite = getSuite(ctx, suiteId);
  const runId = value.run_id as string;
  let runVariantId = value.run_variant_id as string | null;
  const run = ctx.db.get("runs", runId);
  if (!run || run.suite_id !== suiteId) {
    throw new NotFoundError(`Run '${runId}' does not belong to this suite`);
  }
  if (run.status !== "completed") {
    throw new InvalidRequestError("Only completed runs can be used as a baseline");
  }
  const variants = runVariants(ctx, runId);
  if (runVariantId === null) {
    if (variants.length !== 1) {
      throw new InvalidRequestError(
        "This run evaluated several variants; choose which one is the baseline",
      );
    }
    runVariantId = variants[0].id;
  } else if (!variants.some((v) => v.id === runVariantId)) {
    throw new InvalidRequestError(`Variant '${runVariantId}' is not part of run '${runId}'`);
  }
  suite.baseline_run_id = run.id;
  suite.baseline_run_variant_id = runVariantId;
  suite.updated_at = utcnow();
  ctx.db.changed();
  return getSuiteDetail(ctx, suiteId);
}

export function clearBaseline(ctx: Context, suiteId: string) {
  const suite = getSuite(ctx, suiteId);
  suite.baseline_run_id = null;
  suite.baseline_run_variant_id = null;
  suite.updated_at = utcnow();
  ctx.db.changed();
  return getSuiteDetail(ctx, suiteId);
}
