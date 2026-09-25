import type { ArmMetrics, CaseComparison, ComparisonReport } from "@/lib/api/types";

export function metrics(overall: number, correctness: number): ArmMetrics {
  return {
    total_cases: 3,
    succeeded: 3,
    failed: 0,
    pending: 0,
    scored_cases: 3,
    overall_score: overall,
    pass_rate: overall,
    evaluators: [
      {
        evaluator_key: "correct",
        evaluator_name: "Correctness",
        mean_score: correctness,
        pass_rate: correctness,
        scored: 3,
        errors: 0,
      },
      {
        evaluator_key: "cite",
        evaluator_name: "Cites a passage",
        mean_score: overall,
        pass_rate: overall,
        scored: 3,
        errors: 0,
      },
    ],
    latency: { mean_ms: 200, p50_ms: 200, p95_ms: 300 },
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    generation_cost_usd: 0.01,
    judge_cost_usd: 0.002,
    total_cost_usd: 0.012,
    cost_complete: true,
    retried_generations: 0,
  };
}

function caseRow(key: string, change: string, delta: number, tags: string[]): CaseComparison {
  return {
    test_case_id: `case_${key}`,
    key,
    tags,
    base_status: "succeeded",
    target_status: "succeeded",
    base_score: 0.5,
    target_score: 0.5 + delta,
    delta,
    change,
    mixed: false,
    base_error_type: null,
    target_error_type: null,
    evaluators: [
      {
        evaluator_key: "correct",
        evaluator_name: "Correctness",
        threshold: 0.05,
        base_score: 0.5,
        target_score: 0.5 + delta,
        base_passed: true,
        target_passed: delta >= 0,
        delta,
        change,
      },
    ],
  };
}

const arm = (id: string, name: string) => ({
  run_id: "run_1",
  run_name: "Run 1",
  run_status: "completed",
  run_created_at: "2026-01-01T00:00:00Z",
  run_variant_id: id,
  variant_name: name,
  provider: "mock",
  model: "mock-small",
  is_baseline: id === "rv_base",
});

export function report(): ComparisonReport {
  return {
    base: arm("rv_base", "Baseline"),
    target: arm("rv_cand", "Candidate"),
    coverage: { shared: 3, base_only: 0, target_only: 0 },
    base_metrics: metrics(0.5, 0.8),
    target_metrics: metrics(0.7, 0.6),
    overall_delta: 0.2,
    counts: { improved: 2, regressed: 1, unchanged: 0, incomparable: 0 },
    evaluators: [{ key: "correct", name: "Correctness", type: "llm_judge", scoring: "graded" }],
    cases: [
      caseRow("alpha", "improved", 0.3, ["easy"]),
      caseRow("beta", "regressed", -0.4, ["hard"]),
      caseRow("gamma", "improved", 0.1, ["easy"]),
    ],
    slices: [
      {
        tag: "hard",
        cases: 1,
        base_score: 0.9,
        target_score: 0.5,
        delta: -0.4,
        base_pass_rate: 1,
        target_pass_rate: 0,
        improved: 0,
        regressed: 1,
        regressed_slice: true,
        hidden_regression: true,
      },
    ],
    slice_threshold: 0.02,
    slice_evaluator: null,
  };
}
