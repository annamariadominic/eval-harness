import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIGS,
  EVALUATOR_FIELDS,
  describeEvaluator,
  listFromText,
} from "./evaluator-forms";

describe("evaluator form definitions", () => {
  it("covers every evaluator type with fields and defaults", () => {
    expect(Object.keys(EVALUATOR_FIELDS).sort()).toEqual(Object.keys(DEFAULT_CONFIGS).sort());
    for (const [type, fields] of Object.entries(EVALUATOR_FIELDS)) {
      for (const field of fields) {
        expect(DEFAULT_CONFIGS[type], `${type}.${field.key}`).toHaveProperty(field.key);
      }
    }
  });

  it("describes configs in plain language", () => {
    expect(describeEvaluator("regex", { pattern: "\\[\\d+\\]", should_match: true })).toBe(
      "Matches /\\[\\d+\\]/",
    );
    expect(describeEvaluator("regex", { pattern: "as an AI", should_match: false })).toBe(
      "Must not match /as an AI/",
    );
    expect(
      describeEvaluator("llm_judge", {
        provider: "mock",
        model: "mock-large",
        score_min: 1,
        score_max: 5,
        pass_threshold: 0.75,
      }),
    ).toBe("mock/mock-large scores 1-5, passes at 75%");
    expect(describeEvaluator("field_match", { fields: null, numeric_tolerance: 0.005 })).toBe(
      "Compares every expected field within 0.5%",
    );
  });

  it("parses list fields", () => {
    expect(listFromText("company\n revenue \n\n", false)).toEqual(["company", "revenue"]);
    expect(listFromText("", true)).toBeNull();
    expect(listFromText("", false)).toEqual([]);
  });
});
