import { describe, expect, it } from "vitest";

import type { CaseComparison } from "@/lib/api/types";

import {
  EMPTY_FILTERS,
  armOptions,
  countBy,
  defaultArms,
  filterCases,
  sortCases,
} from "./comparison";

function item(
  id: string,
  change: string,
  delta: number | null,
  extra: Partial<CaseComparison> = {},
): CaseComparison {
  return {
    test_case_id: id,
    key: id,
    tags: [],
    base_status: "succeeded",
    target_status: "succeeded",
    base_score: 0.5,
    target_score: delta === null ? null : 0.5 + delta,
    delta,
    change,
    mixed: false,
    base_error_type: null,
    target_error_type: null,
    evaluators: [],
    ...extra,
  };
}

const judge = (change: string, delta: number, targetPassed = true) => ({
  evaluator_key: "judge",
  evaluator_name: "Judge",
  threshold: 0.05,
  base_score: 0.5,
  target_score: 0.5 + delta,
  base_passed: true,
  target_passed: targetPassed,
  delta,
  change,
});

const cases = [
  item("a", "regressed", -0.4, { tags: ["hard"], evaluators: [judge("regressed", -0.4, false)] }),
  item("b", "improved", 0.3, { tags: ["easy"], evaluators: [judge("unchanged", 0)] }),
  item("c", "unchanged", 0, { tags: ["hard"], evaluators: [judge("improved", 0.2)] }),
  item("d", "incomparable", null, { target_status: "failed", target_error_type: "timeout" }),
];

describe("arm selection", () => {
  const run = {
    id: "run_2",
    name: "Run 2",
    variants: [
      { id: "rv_a", name: "A", model: "m" },
      { id: "rv_b", name: "B", model: "m" },
    ],
  };
  const baseline = {
    run_id: "run_1",
    run_name: "Run 1",
    run_variant_id: "rv_base",
    variant_name: "Base",
  };

  it("prefers the suite baseline as the reference", () => {
    expect(defaultArms(run, baseline)).toEqual({ base: "rv_base", target: "rv_b" });
    expect(armOptions(run, baseline).map((o) => o.id)).toEqual(["rv_base", "rv_a", "rv_b"]);
  });

  it("falls back to the first variant in the run, or a single-arm view", () => {
    expect(defaultArms(run, null)).toEqual({ base: "rv_a", target: "rv_b" });
    expect(defaultArms({ ...run, variants: [run.variants[0]] }, null)).toEqual({
      base: null,
      target: "rv_a",
    });
  });

  it("does not compare the baseline arm with itself", () => {
    const own = { ...baseline, run_id: "run_2", run_variant_id: "rv_b" };
    expect(defaultArms(run, own)).toEqual({ base: "rv_a", target: "rv_b" });
    expect(armOptions(run, own).find((o) => o.id === "rv_b")?.isBaseline).toBe(true);
  });
});

describe("case filtering", () => {
  it("filters by case-level change, tag, and search", () => {
    expect(filterCases(cases, { ...EMPTY_FILTERS, change: "regressed" }).map((c) => c.key)).toEqual(
      ["a"],
    );
    expect(filterCases(cases, { ...EMPTY_FILTERS, tag: "hard" }).map((c) => c.key)).toEqual([
      "a",
      "c",
    ]);
    expect(filterCases(cases, { ...EMPTY_FILTERS, search: "B" }).map((c) => c.key)).toEqual(["b"]);
  });

  it("uses a single evaluator's change when one is selected", () => {
    const filters = { ...EMPTY_FILTERS, evaluator: "judge", change: "improved" as const };
    expect(filterCases(cases, filters).map((c) => c.key)).toEqual(["c"]);
  });

  it("finds generation errors and failing checks", () => {
    expect(filterCases(cases, { ...EMPTY_FILTERS, change: "errors" }).map((c) => c.key)).toEqual([
      "d",
    ]);
    expect(filterCases(cases, { ...EMPTY_FILTERS, change: "failing" }).map((c) => c.key)).toEqual([
      "a",
      "d",
    ]);
  });

  it("counts every bucket", () => {
    expect(countBy(cases, null)).toEqual({
      all: 4,
      regressed: 1,
      improved: 1,
      unchanged: 1,
      errors: 1,
      failing: 2,
    });
    expect(countBy(cases, "judge")).toMatchObject({ regressed: 1, improved: 1, unchanged: 1 });
  });
});

describe("case sorting", () => {
  it("puts the largest drops first and cases without deltas last", () => {
    expect(sortCases(cases, "worst", null).map((c) => c.key)).toEqual(["a", "c", "b", "d"]);
    expect(sortCases(cases, "best", null).map((c) => c.key)).toEqual(["b", "c", "a", "d"]);
    expect(sortCases(cases, "dataset", null)).toBe(cases);
  });

  it("sorts by one evaluator's delta when selected", () => {
    expect(sortCases(cases, "best", "judge").map((c) => c.key)).toEqual(["c", "b", "a", "d"]);
  });
});
