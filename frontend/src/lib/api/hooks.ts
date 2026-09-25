"use client";

import useSWR, { type SWRConfiguration } from "swr";

import { api, query } from "./client";
import {
  ACTIVE_RUN_STATUSES,
  type CaseResults,
  type ComparisonReport,
  type Evaluator,
  type EvaluatorType,
  type Provider,
  type Run,
  type RunDetail,
  type SuiteDetail,
  type SuiteSummary,
  type TestCase,
  type Variant,
} from "./types";

const fetcher = <T,>(path: string) => api.get<T>(path);
const POLL_MS = 1000;

function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, fetcher, { revalidateOnFocus: false, ...config });
}

export const keys = {
  suites: "/suites",
  suite: (id: string) => `/suites/${id}`,
  testCases: (id: string) => `/suites/${id}/test-cases`,
  variants: (id: string) => `/suites/${id}/variants`,
  evaluators: (id: string) => `/suites/${id}/evaluators`,
  suiteRuns: (id: string) => `/suites/${id}/runs`,
  runs: "/runs",
  run: (id: string) => `/runs/${id}`,
};

export const useSuites = () => useApi<SuiteSummary[]>(keys.suites);
export const useSuite = (id: string) => useApi<SuiteDetail>(keys.suite(id));
export const useTestCases = (id: string) => useApi<TestCase[]>(keys.testCases(id));
export const useVariants = (id: string) => useApi<Variant[]>(keys.variants(id));
export const useEvaluators = (id: string) => useApi<Evaluator[]>(keys.evaluators(id));
export const useProviders = () => useApi<Provider[]>("/providers");
export const useEvaluatorTypes = () => useApi<EvaluatorType[]>("/evaluator-types");

const anyActive = (runs: Run[] | undefined) =>
  (runs ?? []).some((run) => ACTIVE_RUN_STATUSES.has(run.status));

export const useRuns = (suiteId?: string) =>
  useApi<Run[]>(suiteId ? keys.suiteRuns(suiteId) : keys.runs, {
    refreshInterval: (runs) => (anyActive(runs) ? POLL_MS : 0),
  });

/** Polls while the run is executing, then stops. */
export const useRun = (id: string) =>
  useApi<RunDetail>(keys.run(id), {
    refreshInterval: (run) => (run && ACTIVE_RUN_STATUSES.has(run.status) ? POLL_MS : 0),
  });

export const useComparison = (
  target: string | null,
  base: string | null,
  sliceEvaluator: string | null,
  refreshKey: string,
) =>
  useApi<ComparisonReport>(
    target
      ? `/compare${query({ target, base, slice_evaluator: sliceEvaluator, v: refreshKey })}`
      : null,
    { keepPreviousData: true },
  );

export const useCaseResults = (testCaseId: string, arms: string[]) =>
  useApi<CaseResults>(
    arms.length ? `/case-results${query({ test_case_id: testCaseId, arms })}` : null,
  );
