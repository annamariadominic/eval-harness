/**
 * Port of `app/analysis/`: aggregation, comparison with regression detection, and slices.
 *
 * Pure functions over plain records, exactly like the Python package. The methodology is
 * documented there (`metrics.py`, `comparison.py`, `slices.py`); names and field order match
 * so the two read side by side.
 */

import { pyCompare, pyMean, pySum } from "./py";

// --- records ---------------------------------------------------------------------------------

export type ScoreRecord = {
  evaluator_key: string;
  evaluator_name: string;
  status: string;
  score: number | null;
  passed: boolean | null;
  regression_threshold: number;
  reason: string;
  cost_usd: number | null;
};

/** One test case's outcome for one variant (an "arm") in one run. */
export type CaseRecord = {
  test_case_id: string;
  key: string | null;
  tags: string[];
  status: string;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  attempts: number;
  error_type: string | null;
  scores: ScoreRecord[];
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export const usable = (s: ScoreRecord) => s.status === "succeeded" && s.score !== null;
export const succeeded = (c: CaseRecord) => c.status === "succeeded";

/** Case-level quality: the unweighted mean of its successful evaluator scores. */
export function caseScore(c: CaseRecord): number | null {
  return pyMean(c.scores.filter(usable).map((s) => s.score as number));
}

/** A case passes when every evaluator that produced a verdict passed. */
export function casePassed(c: CaseRecord): boolean | null {
  const verdicts = c.scores.filter((s) => usable(s) && s.passed !== null).map((s) => s.passed);
  return verdicts.length ? verdicts.every(Boolean) : null;
}

export function scoreFor(c: CaseRecord, key: string): ScoreRecord | null {
  return c.scores.find((s) => s.evaluator_key === key) ?? null;
}

// --- metrics ---------------------------------------------------------------------------------

export type EvaluatorMetrics = {
  evaluator_key: string;
  evaluator_name: string;
  mean_score: number | null;
  pass_rate: number | null;
  scored: number;
  errors: number;
};

export type ArmMetrics = {
  total_cases: number;
  succeeded: number;
  failed: number;
  pending: number;
  scored_cases: number;
  overall_score: number | null;
  pass_rate: number | null;
  evaluators: EvaluatorMetrics[];
  latency: { mean_ms: number | null; p50_ms: number | null; p95_ms: number | null };
  input_tokens: number;
  output_tokens: number;
  generation_cost_usd: number | null;
  judge_cost_usd: number | null;
  cost_complete: boolean;
  retried_generations: number;
  total_cost_usd: number | null;
  total_tokens: number;
};

/** Nearest-rank percentile; stable and easy to explain for small samples. */
export function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((ordered.length * pct) / 100));
  return ordered[rank - 1];
}

/** Sum known values (naively, as the backend does); also report whether all were known. */
function sumOptional(values: Array<number | null>): [number | null, boolean] {
  let total: number | null = null;
  let complete = true;
  for (const value of values) {
    if (value === null) {
      complete = false;
      continue;
    }
    total = (total ?? 0.0) + value;
  }
  return [total, complete];
}

const passRate = (verdicts: boolean[]) => pyMean(verdicts.map((p) => (p ? 1.0 : 0.0)));

export function aggregateArm(cases: CaseRecord[]): ArmMetrics {
  const ok = cases.filter(succeeded);
  const caseScores = ok.map(caseScore).filter((s): s is number => s !== null);
  const verdicts = ok.map(casePassed).filter((p): p is boolean => p !== null);

  const evaluatorOrder = new Map<string, string>();
  for (const c of cases) {
    for (const s of c.scores) {
      if (!evaluatorOrder.has(s.evaluator_key))
        evaluatorOrder.set(s.evaluator_key, s.evaluator_name);
    }
  }
  const evaluators: EvaluatorMetrics[] = [];
  for (const [key, name] of evaluatorOrder) {
    const records = ok.map((c) => scoreFor(c, key)).filter((r): r is ScoreRecord => r !== null);
    const good = records.filter(usable);
    const passes = good.filter((r) => r.passed !== null).map((r) => r.passed as boolean);
    evaluators.push({
      evaluator_key: key,
      evaluator_name: name,
      mean_score: pyMean(good.map((r) => r.score as number)),
      pass_rate: passRate(passes),
      scored: good.length,
      errors: records.filter((r) => r.status === "failed").length,
    });
  }

  const latencies = ok.map((c) => c.latency_ms).filter((l): l is number => l !== null);
  const [generationCost, generationComplete] = sumOptional(ok.map((c) => c.cost_usd));
  const judgeCosts = ok.flatMap((c) =>
    c.scores.filter((s) => usable(s) && s.cost_usd !== null).map((s) => s.cost_usd as number),
  );
  const judgeCost = judgeCosts.length ? pySum(judgeCosts) : null;
  const inputTokens = ok.reduce((sum, c) => sum + (c.input_tokens ?? 0), 0);
  const outputTokens = ok.reduce((sum, c) => sum + (c.output_tokens ?? 0), 0);
  const costParts = [generationCost, judgeCost].filter((c): c is number => c !== null);
  return {
    total_cases: cases.length,
    succeeded: ok.length,
    failed: cases.filter((c) => c.status === "failed").length,
    pending: cases.filter((c) => !TERMINAL.has(c.status)).length,
    scored_cases: caseScores.length,
    overall_score: pyMean(caseScores),
    pass_rate: passRate(verdicts),
    evaluators,
    latency: {
      mean_ms: pyMean(latencies),
      p50_ms: percentile(latencies, 50),
      p95_ms: percentile(latencies, 95),
    },
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    generation_cost_usd: generationCost,
    judge_cost_usd: judgeCost,
    cost_complete: generationComplete,
    retried_generations: cases.filter((c) => c.attempts > 1).length,
    total_cost_usd: costParts.length ? pySum(costParts) : null,
    total_tokens: inputTokens + outputTokens,
  };
}

// --- comparison ------------------------------------------------------------------------------

export type Change = "improved" | "regressed" | "unchanged" | "incomparable";

const EPSILON = 1e-9;
const DEFAULT_THRESHOLD = 0.05;

export type EvaluatorDelta = {
  evaluator_key: string;
  evaluator_name: string;
  threshold: number;
  base_score: number | null;
  target_score: number | null;
  base_passed: boolean | null;
  target_passed: boolean | null;
  delta: number | null;
  change: Change;
};

export type CaseComparison = {
  test_case_id: string;
  key: string | null;
  tags: string[];
  base_status: string | null;
  target_status: string | null;
  base_score: number | null;
  target_score: number | null;
  delta: number | null;
  change: Change;
  mixed: boolean;
  base_error_type: string | null;
  target_error_type: string | null;
  evaluators: EvaluatorDelta[];
};

export type ChangeCounts = Record<Change, number>;

export function classify(
  base: ScoreRecord | null,
  target: ScoreRecord | null,
  threshold: number,
): [Change, number | null] {
  if (base === null || target === null || !usable(base) || !usable(target)) {
    return ["incomparable", null];
  }
  const delta = (target.score as number) - (base.score as number);
  if (delta < -threshold - EPSILON || (base.passed === true && target.passed === false)) {
    return ["regressed", delta];
  }
  if (delta > threshold + EPSILON || (base.passed === false && target.passed === true)) {
    return ["improved", delta];
  }
  return ["unchanged", delta];
}

export function compareCase(base: CaseRecord | null, target: CaseRecord): CaseComparison {
  const keys = new Map<string, string>();
  for (const record of [...(base?.scores ?? []), ...target.scores]) {
    if (!keys.has(record.evaluator_key)) keys.set(record.evaluator_key, record.evaluator_name);
  }

  const deltas: EvaluatorDelta[] = [];
  for (const [key, name] of keys) {
    const baseScore = base ? scoreFor(base, key) : null;
    const targetScore = scoreFor(target, key);
    // The candidate's threshold wins: it reflects the evaluator's current configuration.
    const reference = targetScore ?? baseScore;
    const threshold = reference ? reference.regression_threshold : DEFAULT_THRESHOLD;
    const [change, delta] = classify(baseScore, targetScore, threshold);
    deltas.push({
      evaluator_key: key,
      evaluator_name: name,
      threshold,
      base_score: baseScore ? baseScore.score : null,
      target_score: targetScore ? targetScore.score : null,
      base_passed: baseScore ? baseScore.passed : null,
      target_passed: targetScore ? targetScore.passed : null,
      delta,
      change,
    });
  }

  const changes = new Set(deltas.map((d) => d.change));
  const change: Change = changes.has("regressed")
    ? "regressed"
    : changes.has("improved")
      ? "improved"
      : changes.has("unchanged")
        ? "unchanged"
        : "incomparable";

  const baseCaseScore = base ? caseScore(base) : null;
  const targetCaseScore = caseScore(target);
  return {
    test_case_id: target.test_case_id,
    key: target.key,
    tags: target.tags,
    base_status: base ? base.status : null,
    target_status: target.status,
    base_score: baseCaseScore,
    target_score: targetCaseScore,
    delta:
      baseCaseScore !== null && targetCaseScore !== null ? targetCaseScore - baseCaseScore : null,
    change,
    mixed: changes.has("regressed") && changes.has("improved"),
    base_error_type: base ? base.error_type : null,
    target_error_type: target.error_type,
    evaluators: deltas,
  };
}

export type PairedCases = {
  shared: Array<[CaseRecord, CaseRecord]>;
  base_only: CaseRecord[];
  target_only: CaseRecord[];
};

export function pairCases(base: CaseRecord[], target: CaseRecord[]): PairedCases {
  const baseById = new Map(base.map((c) => [c.test_case_id, c]));
  const targetIds = new Set(target.map((c) => c.test_case_id));
  return {
    shared: target
      .filter((c) => baseById.has(c.test_case_id))
      .map((c): [CaseRecord, CaseRecord] => [baseById.get(c.test_case_id)!, c]),
    base_only: base.filter((c) => !targetIds.has(c.test_case_id)),
    target_only: target.filter((c) => !baseById.has(c.test_case_id)),
  };
}

export function countChanges(comparisons: CaseComparison[]): ChangeCounts {
  const count = (change: Change) => comparisons.filter((c) => c.change === change).length;
  return {
    improved: count("improved"),
    regressed: count("regressed"),
    unchanged: count("unchanged"),
    incomparable: count("incomparable"),
  };
}

// --- slices ----------------------------------------------------------------------------------

export const UNTAGGED = "(untagged)";
export const DEFAULT_SLICE_THRESHOLD = 0.02;

export type SliceRow = {
  tag: string;
  cases: number;
  base_score: number | null;
  target_score: number | null;
  delta: number | null;
  base_pass_rate: number | null;
  target_pass_rate: number | null;
  improved: number;
  regressed: number;
  regressed_slice: boolean;
  hidden_regression: boolean;
};

const tagsOf = (c: CaseRecord) => (c.tags.length ? c.tags : [UNTAGGED]);

function sliceScore(
  cases: CaseRecord[],
  evaluatorKey: string | null,
): [number | null, number | null] {
  const scored = cases.filter(succeeded);
  if (evaluatorKey === null) {
    return [
      pyMean(scored.map(caseScore).filter((s): s is number => s !== null)),
      passRate(scored.map(casePassed).filter((p): p is boolean => p !== null)),
    ];
  }
  const records = scored
    .map((c) => scoreFor(c, evaluatorKey))
    .filter((r): r is ScoreRecord => r !== null && usable(r));
  return [
    pyMean(records.map((r) => r.score as number)),
    passRate(records.filter((r) => r.passed !== null).map((r) => r.passed as boolean)),
  ];
}

function changeFor(comparison: CaseComparison, evaluatorKey: string | null): Change {
  if (evaluatorKey === null) return comparison.change;
  const delta = comparison.evaluators.find((d) => d.evaluator_key === evaluatorKey);
  return delta ? delta.change : "incomparable";
}

/** `targetCases` and `baseCases` should already be restricted to shared cases. */
export function computeSlices(
  targetCases: CaseRecord[],
  baseCases: CaseRecord[] | null = null,
  comparisons: CaseComparison[] = [],
  options: {
    overallDelta?: number | null;
    sliceThreshold?: number;
    evaluatorKey?: string | null;
  } = {},
): SliceRow[] {
  const {
    overallDelta = null,
    sliceThreshold = DEFAULT_SLICE_THRESHOLD,
    evaluatorKey = null,
  } = options;
  const tags = [...new Set(targetCases.flatMap(tagsOf))].sort(
    (a, b) => Number(a === UNTAGGED) - Number(b === UNTAGGED) || pyCompare(a, b),
  );
  const comparisonByCase = new Map(comparisons.map((c) => [c.test_case_id, c]));
  return tags.map((tag): SliceRow => {
    const targetSlice = targetCases.filter((c) => tagsOf(c).includes(tag));
    const baseSlice = (baseCases ?? []).filter((c) => tagsOf(c).includes(tag));
    const [targetScore, targetPass] = sliceScore(targetSlice, evaluatorKey);
    const [baseScore, basePass] =
      baseCases !== null ? sliceScore(baseSlice, evaluatorKey) : [null, null];
    const delta = targetScore !== null && baseScore !== null ? targetScore - baseScore : null;
    const changes = targetSlice
      .filter((c) => comparisonByCase.has(c.test_case_id))
      .map((c) => changeFor(comparisonByCase.get(c.test_case_id)!, evaluatorKey));
    const regressedSlice = delta !== null && delta < -sliceThreshold;
    return {
      tag,
      cases: targetSlice.length,
      base_score: baseScore,
      target_score: targetScore,
      delta,
      base_pass_rate: basePass,
      target_pass_rate: targetPass,
      improved: changes.filter((c) => c === "improved").length,
      regressed: changes.filter((c) => c === "regressed").length,
      regressed_slice: regressedSlice,
      hidden_regression: regressedSlice && overallDelta !== null && overallDelta >= 0,
    };
  });
}
