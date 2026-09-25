/** Client-side logic for the comparison dashboard: choosing arms, filtering, and sorting. */

import type { CaseComparison, EvaluatorDelta } from "@/lib/api/types";

export type ArmOption = {
  id: string;
  label: string;
  detail: string;
  isBaseline: boolean;
  inRun: boolean;
};

type RunLike = {
  id: string;
  name: string;
  variants: Array<{ id: string; name: string; model: string }>;
};
type BaselineLike = {
  run_id: string;
  run_name: string;
  run_variant_id: string;
  variant_name: string;
} | null;

/** Arms available for comparison: this run's variants plus the suite baseline (if elsewhere). */
export function armOptions(run: RunLike, baseline: BaselineLike): ArmOption[] {
  const options: ArmOption[] = run.variants.map((variant) => ({
    id: variant.id,
    label: variant.name,
    detail: variant.model,
    isBaseline: baseline?.run_variant_id === variant.id,
    inRun: true,
  }));
  if (baseline && !options.some((o) => o.id === baseline.run_variant_id)) {
    options.unshift({
      id: baseline.run_variant_id,
      label: baseline.variant_name,
      detail: baseline.run_name,
      isBaseline: true,
      inRun: false,
    });
  }
  return options;
}

/**
 * Default pairing: the candidate is the run's last variant (baselines conventionally come first);
 * the reference is the suite baseline when there is one, otherwise the run's first variant.
 */
export function defaultArms(
  run: RunLike,
  baseline: BaselineLike,
): { base: string | null; target: string | null } {
  const target = run.variants.at(-1)?.id ?? null;
  if (baseline && baseline.run_variant_id !== target)
    return { base: baseline.run_variant_id, target };
  const first = run.variants[0]?.id ?? null;
  return { base: first && first !== target ? first : null, target };
}

export type ChangeFilter = "all" | "regressed" | "improved" | "unchanged" | "errors" | "failing";

export type CaseFilters = {
  change: ChangeFilter;
  tag: string | null;
  evaluator: string | null;
  search: string;
};

export const EMPTY_FILTERS: CaseFilters = { change: "all", tag: null, evaluator: null, search: "" };

export function evaluatorDelta(
  item: CaseComparison,
  key: string | null,
): EvaluatorDelta | undefined {
  return key ? item.evaluators.find((d) => d.evaluator_key === key) : undefined;
}

/** The change that matters under the current filters: one evaluator's, or the whole case's. */
export function effectiveChange(item: CaseComparison, evaluator: string | null): string {
  if (!evaluator) return item.change;
  return evaluatorDelta(item, evaluator)?.change ?? "incomparable";
}

export function hasError(item: CaseComparison): boolean {
  return item.target_status === "failed" || item.base_status === "failed";
}

export function isFailing(item: CaseComparison, evaluator: string | null): boolean {
  const deltas = evaluator
    ? item.evaluators.filter((d) => d.evaluator_key === evaluator)
    : item.evaluators;
  return item.target_status === "failed" || deltas.some((d) => d.target_passed === false);
}

export function filterCases(cases: CaseComparison[], filters: CaseFilters): CaseComparison[] {
  const needle = filters.search.trim().toLowerCase();
  return cases.filter((item) => {
    if (filters.tag && !item.tags.includes(filters.tag)) return false;
    if (needle && !(item.key ?? item.test_case_id).toLowerCase().includes(needle)) return false;
    switch (filters.change) {
      case "all":
        return true;
      case "errors":
        return hasError(item);
      case "failing":
        return isFailing(item, filters.evaluator);
      default:
        return effectiveChange(item, filters.evaluator) === filters.change;
    }
  });
}

export type SortOrder = "dataset" | "worst" | "best";

export function sortCases(
  cases: CaseComparison[],
  order: SortOrder,
  evaluator: string | null,
): CaseComparison[] {
  if (order === "dataset") return cases;
  const deltaOf = (item: CaseComparison) =>
    (evaluator ? evaluatorDelta(item, evaluator)?.delta : item.delta) ?? null;
  return [...cases].sort((a, b) => {
    const da = deltaOf(a);
    const db = deltaOf(b);
    if (da === null && db === null) return 0;
    if (da === null) return 1; // cases without a delta sink to the bottom
    if (db === null) return -1;
    return order === "worst" ? da - db : db - da;
  });
}

export function countBy(
  cases: CaseComparison[],
  evaluator: string | null,
): Record<ChangeFilter, number> {
  const counts: Record<ChangeFilter, number> = {
    all: cases.length,
    regressed: 0,
    improved: 0,
    unchanged: 0,
    errors: 0,
    failing: 0,
  };
  for (const item of cases) {
    const change = effectiveChange(item, evaluator);
    if (change === "regressed" || change === "improved" || change === "unchanged")
      counts[change] += 1;
    if (hasError(item)) counts.errors += 1;
    if (isFailing(item, evaluator)) counts.failing += 1;
  }
  return counts;
}
