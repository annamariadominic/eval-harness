/** Pure planning math for the run configuration form. */

export type PlanInput = {
  cases: Array<{ id: string; tags: string[] }>;
  tagFilter: string[];
  variantCount: number;
  evaluatorTypes: string[];
};

export type RunPlan = {
  caseIds: string[];
  generations: number;
  evaluations: number;
  judgeCalls: number;
};

/** Cases carrying at least one of the selected tags (all cases when no tag is selected). */
export function selectCases(cases: PlanInput["cases"], tagFilter: string[]): string[] {
  if (tagFilter.length === 0) return cases.map((c) => c.id);
  const wanted = new Set(tagFilter);
  return cases.filter((c) => c.tags.some((tag) => wanted.has(tag))).map((c) => c.id);
}

export function planRun({ cases, tagFilter, variantCount, evaluatorTypes }: PlanInput): RunPlan {
  const caseIds = selectCases(cases, tagFilter);
  const generations = caseIds.length * variantCount;
  return {
    caseIds,
    generations,
    evaluations: generations * evaluatorTypes.length,
    judgeCalls: generations * evaluatorTypes.filter((type) => type === "llm_judge").length,
  };
}
