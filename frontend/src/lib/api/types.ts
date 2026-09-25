/** Friendly aliases over the generated OpenAPI schema. Regenerate with `npm run gen:api`. */
import type { components } from "./schema";

type S = components["schemas"];

export type SuiteSummary = S["SuiteSummary"];
export type SuiteDetail = S["SuiteDetail"];
export type ArmScore = S["ArmScore"];
export type TestCase = S["TestCaseOut"];
export type TestCaseCreate = S["TestCaseCreate-Input"];
export type TestCaseUpdate = S["TestCaseUpdate"];
export type DatasetImportRequest = S["DatasetImportRequest"];
export type DatasetImportResult = S["DatasetImportResult"];
export type ImportIssue = S["ImportIssue"];
export type Variant = S["VariantOut"];
export type VariantCreate = S["VariantCreate"];
export type VariantUpdate = S["VariantUpdate"];
export type Evaluator = S["EvaluatorOut"];
export type EvaluatorCreate = S["EvaluatorCreate"];
export type EvaluatorUpdate = S["EvaluatorUpdate"];
export type EvaluatorType = S["EvaluatorTypeOut"];
export type Provider = S["ProviderOut"];
export type Run = S["RunOut"];
export type RunDetail = S["RunDetail"];
export type RunCreate = S["RunCreate"];
export type RunVariant = S["RunVariantOut"];
export type RunEvaluator = S["RunEvaluatorOut"];
export type RunProgress = S["RunProgress"];
export type ComparisonReport = S["ComparisonReport"];
export type CaseComparison = S["CaseComparisonOut"];
export type EvaluatorDelta = S["EvaluatorDeltaOut"];
export type ArmMetrics = S["ArmMetricsOut"];
export type ArmRef = S["ArmRef"];
export type SliceRow = S["SliceRowOut"];
export type EvaluatorRef = S["EvaluatorRef"];
export type CaseResults = S["CaseResults"];
export type ArmResult = S["ArmResult"];
export type ScoreDetail = S["ScoreDetail"];

export type Change = "improved" | "regressed" | "unchanged" | "incomparable";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);
