import { describe, expect, it } from "vitest";

import { planRun, selectCases } from "./run-plan";

const cases = [
  { id: "a", tags: ["easy", "financial"] },
  { id: "b", tags: ["hard"] },
  { id: "c", tags: [] },
];

describe("run planning", () => {
  it("selects all cases without a tag filter and matches any tag otherwise", () => {
    expect(selectCases(cases, [])).toEqual(["a", "b", "c"]);
    expect(selectCases(cases, ["hard", "financial"])).toEqual(["a", "b"]);
    expect(selectCases(cases, ["missing"])).toEqual([]);
  });

  it("multiplies cases by variants and counts judge calls", () => {
    expect(
      planRun({
        cases,
        tagFilter: [],
        variantCount: 2,
        evaluatorTypes: ["llm_judge", "regex", "llm_judge"],
      }),
    ).toEqual({ caseIds: ["a", "b", "c"], generations: 6, evaluations: 18, judgeCalls: 12 });
  });
});
