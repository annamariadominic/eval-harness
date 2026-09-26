/**
 * Ports of `app/services/arm_records.py` and `app/services/comparisons.py`: load persisted
 * results as analysis records, then assemble comparison reports and per-case inspection views.
 */

import {
  aggregateArm,
  compareCase,
  computeSlices,
  countChanges,
  DEFAULT_SLICE_THRESHOLD,
  pairCases,
  type ArmMetrics,
  type CaseRecord,
} from "../../engine";
import type { Context } from "../context";
import type { Database, Row } from "../db";
import { InvalidRequestError, NotFoundError } from "../errors";
import { byPosition } from "./suites";

export function evaluatorKey(evaluator: Row): string {
  return (evaluator.evaluator_id as string | null) ?? `name:${evaluator.name}`;
}

function scoresFor(db: Database, resultId: string): Array<{ score: Row; evaluator: Row }> {
  return db
    .where("evaluator_scores", "result_id", resultId)
    .map((score) => ({
      score,
      evaluator: db.get("run_evaluators", score.run_evaluator_id as string)!,
    }))
    .sort((a, b) => (a.evaluator.position as number) - (b.evaluator.position as number));
}

export function toCaseRecord(db: Database, result: Row): CaseRecord {
  const runCase = db.get("run_cases", result.run_case_id as string)!;
  return {
    test_case_id: runCase.test_case_id as string,
    key: runCase.key as string | null,
    tags: [...(runCase.tags as string[])],
    status: result.status as string,
    latency_ms: result.latency_ms as number | null,
    input_tokens: result.input_tokens as number | null,
    output_tokens: result.output_tokens as number | null,
    cost_usd: result.cost_usd as number | null,
    attempts: result.attempts as number,
    error_type: result.error_type as string | null,
    scores: scoresFor(db, result.id).map(({ score, evaluator }) => ({
      evaluator_key: evaluatorKey(evaluator),
      evaluator_name: evaluator.name as string,
      status: score.status as string,
      score: score.score as number | null,
      passed: score.passed as boolean | null,
      regression_threshold: evaluator.regression_threshold as number,
      reason: score.reason as string,
      cost_usd: score.cost_usd as number | null,
    })),
  };
}

export function loadArmRecords(db: Database, runVariantId: string): CaseRecord[] {
  const position = (result: Row) =>
    db.get("run_cases", result.run_case_id as string)!.position as number;
  return db
    .where("results", "run_variant_id", runVariantId)
    .sort((a, b) => position(a) - position(b))
    .map((result) => toCaseRecord(db, result));
}

function loadArm(ctx: Context, runVariantId: string) {
  const variant = ctx.db.get("run_variants", runVariantId);
  if (!variant) throw NotFoundError.forEntity("Run variant", runVariantId);
  const run = ctx.db.get("runs", variant.run_id as string)!;
  const suite = ctx.db.get("eval_suites", run.suite_id as string)!;
  return { variant, run, suite };
}

function armRef({ variant, run, suite }: ReturnType<typeof loadArm>) {
  return {
    run_id: run.id,
    run_name: run.name,
    run_status: run.status,
    run_created_at: run.created_at,
    run_variant_id: variant.id,
    variant_name: variant.name,
    provider: variant.provider,
    model: variant.model,
    is_baseline: suite.baseline_run_variant_id === variant.id,
  };
}

function evaluatorRefs(ctx: Context, ...arms: Array<ReturnType<typeof loadArm>>) {
  const refs = new Map<string, { key: string; name: string; type: string; scoring: string }>();
  for (const { run } of arms) {
    for (const evaluator of byPosition(ctx.db.where("run_evaluators", "run_id", run.id))) {
      const key = evaluatorKey(evaluator);
      if (refs.has(key)) continue;
      const spec = ctx.registry.list().find((t) => t.type === evaluator.type);
      refs.set(key, {
        key,
        name: evaluator.name as string,
        type: evaluator.type as string,
        scoring: spec ? spec.scoring : "fractional",
      });
    }
  }
  return [...refs.values()];
}

function evaluatorDelta(base: ArmMetrics, target: ArmMetrics, key: string): number | null {
  const baseMean = base.evaluators.find((e) => e.evaluator_key === key)?.mean_score ?? null;
  const targetMean = target.evaluators.find((e) => e.evaluator_key === key)?.mean_score ?? null;
  return baseMean === null || targetMean === null ? null : targetMean - baseMean;
}

export function buildComparison(
  ctx: Context,
  targetId: string,
  baseId: string | null = null,
  sliceThreshold = DEFAULT_SLICE_THRESHOLD,
  sliceEvaluator: string | null = null,
) {
  const target = loadArm(ctx, targetId);
  const targetRecords = loadArmRecords(ctx.db, target.variant.id);

  if (baseId === null) {
    return {
      base: null,
      target: armRef(target),
      coverage: { shared: 0, base_only: 0, target_only: targetRecords.length },
      base_metrics: null,
      target_metrics: aggregateArm(targetRecords),
      overall_delta: null,
      counts: null,
      evaluators: evaluatorRefs(ctx, target),
      cases: targetRecords.map((c) => compareCase(null, c)),
      slices: computeSlices(targetRecords, null, [], { evaluatorKey: sliceEvaluator }),
      slice_threshold: sliceThreshold,
      slice_evaluator: sliceEvaluator,
    };
  }

  const base = loadArm(ctx, baseId);
  if (base.run.suite_id !== target.run.suite_id) {
    throw new InvalidRequestError("Only arms from the same suite can be compared");
  }
  const baseRecords = loadArmRecords(ctx.db, base.variant.id);
  const paired = pairCases(baseRecords, targetRecords);
  const sharedBase = paired.shared.map(([b]) => b);
  const sharedTarget = paired.shared.map(([, t]) => t);
  const baseMetrics = aggregateArm(sharedBase);
  const targetMetrics = aggregateArm(sharedTarget);
  const comparisons = paired.shared.map(([b, t]) => compareCase(b, t));
  const overallDelta =
    targetMetrics.overall_score !== null && baseMetrics.overall_score !== null
      ? targetMetrics.overall_score - baseMetrics.overall_score
      : null;
  const sliceOverallDelta =
    sliceEvaluator === null
      ? overallDelta
      : evaluatorDelta(baseMetrics, targetMetrics, sliceEvaluator);
  return {
    base: armRef(base),
    target: armRef(target),
    coverage: {
      shared: paired.shared.length,
      base_only: paired.base_only.length,
      target_only: paired.target_only.length,
    },
    base_metrics: baseMetrics,
    target_metrics: targetMetrics,
    overall_delta: overallDelta,
    counts: countChanges(comparisons),
    evaluators: evaluatorRefs(ctx, target, base),
    cases: comparisons,
    slices: computeSlices(sharedTarget, sharedBase, comparisons, {
      overallDelta: sliceOverallDelta,
      sliceThreshold,
      evaluatorKey: sliceEvaluator,
    }),
    slice_threshold: sliceThreshold,
    slice_evaluator: sliceEvaluator,
  };
}

export function getCaseResults(ctx: Context, testCaseId: string, armIds: string[]) {
  if (armIds.length === 0) throw new InvalidRequestError("Specify at least one arm");
  let snapshot: Row | null = null;
  const arms = [];
  for (const armId of [...new Set(armIds)]) {
    const arm = loadArm(ctx, armId);
    const result = ctx.db
      .where("results", "run_variant_id", armId)
      .find((r) => ctx.db.get("run_cases", r.run_case_id as string)!.test_case_id === testCaseId);
    if (!result) continue;
    snapshot ??= ctx.db.get("run_cases", result.run_case_id as string)!;
    const inputTokens = result.input_tokens as number | null;
    const outputTokens = result.output_tokens as number | null;
    arms.push({
      arm: armRef(arm),
      result_id: result.id,
      status: result.status,
      output: result.output,
      request_messages: result.request_messages,
      response_model: result.response_model,
      latency_ms: result.latency_ms,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens:
        inputTokens === null && outputTokens === null
          ? null
          : (inputTokens ?? 0) + (outputTokens ?? 0),
      cost_usd: result.cost_usd,
      attempts: result.attempts,
      error_type: result.error_type,
      error_message: result.error_message,
      started_at: result.started_at,
      finished_at: result.finished_at,
      scores: scoresFor(ctx.db, result.id).map(({ score, evaluator }) => ({
        evaluator_key: evaluatorKey(evaluator),
        evaluator_name: evaluator.name,
        evaluator_type: evaluator.type,
        status: score.status,
        score: score.score,
        passed: score.passed,
        reason: score.reason,
        details: score.details,
        latency_ms: score.latency_ms,
        input_tokens: score.input_tokens,
        output_tokens: score.output_tokens,
        cost_usd: score.cost_usd,
        error_message: score.error_message,
      })),
    });
  }
  if (snapshot === null) {
    throw new NotFoundError(`Test case '${testCaseId}' has no results in the requested arms`);
  }
  return {
    case: {
      test_case_id: snapshot.test_case_id,
      key: snapshot.key,
      input: snapshot.input,
      expected: snapshot.expected,
      tags: snapshot.tags,
      metadata: snapshot.metadata,
    },
    arms,
  };
}
