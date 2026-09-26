import { describe, expect, it } from "vitest";

import { unitGolden, type Golden } from "../golden";
import {
  aggregateArm,
  compareCase,
  computeSlices,
  countChanges,
  pairCases,
  type CaseRecord,
} from "./analysis";

const cases: Golden[] = unitGolden().analysis;

describe("analysis parity", () => {
  it.each(cases.map((c, i) => [i, c.base === null ? "alone" : "vs base", c.slice_evaluator, c]))(
    "case %i (%s, slice %s)",
    (_i, _label, _slice, c: Golden) => {
      const target = c.target as CaseRecord[];
      const sliceEvaluator = c.slice_evaluator as string | null;
      expect(aggregateArm(target)).toEqual(c.target_metrics);

      if (c.base === null) {
        expect(target.map((t) => compareCase(null, t))).toEqual(c.comparisons);
        expect(computeSlices(target, null, [], { evaluatorKey: sliceEvaluator })).toEqual(c.slices);
        return;
      }

      const paired = pairCases(c.base as CaseRecord[], target);
      expect({
        shared: paired.shared.map(([b, t]) => [b.test_case_id, t.test_case_id]),
        base_only: paired.base_only.map((x) => x.test_case_id),
        target_only: paired.target_only.map((x) => x.test_case_id),
      }).toEqual(c.paired);
      const sharedBase = paired.shared.map(([b]) => b);
      const sharedTarget = paired.shared.map(([, t]) => t);
      const baseMetrics = aggregateArm(sharedBase);
      const targetMetrics = aggregateArm(sharedTarget);
      expect(baseMetrics).toEqual(c.base_metrics);
      expect(targetMetrics).toEqual(c.shared_target_metrics);
      const comparisons = paired.shared.map(([b, t]) => compareCase(b, t));
      expect(comparisons).toEqual(c.comparisons);
      expect(countChanges(comparisons)).toEqual(c.counts);
      const overall =
        targetMetrics.overall_score !== null && baseMetrics.overall_score !== null
          ? targetMetrics.overall_score - baseMetrics.overall_score
          : null;
      expect(overall).toEqual(c.overall_delta);
      expect(
        computeSlices(sharedTarget, sharedBase, comparisons, {
          overallDelta: overall,
          evaluatorKey: sliceEvaluator,
        }),
      ).toEqual(c.slices);
    },
  );
});
