/**
 * Maps `METHOD /path?query` to the service ports, mirroring the FastAPI routes: status codes,
 * query validation, the error envelope, and FastAPI's own 404/405 responses.
 */

import { DEFAULT_SLICE_THRESHOLD } from "../engine";
import type { Context } from "./context";
import { DomainError, envelope, RequestValidationError } from "./errors";
import { buildComparison, getCaseResults } from "./services/comparisons";
import {
  cancelRun,
  createRun,
  deleteRun,
  getRunDetail,
  listRuns,
  resumeRun,
} from "./services/runs";
import {
  clearBaseline,
  createSuite,
  deleteSuite,
  getSuiteDetail,
  listSuites,
  setBaseline,
  updateSuite,
} from "./services/suites";
import {
  createTestCase,
  deleteTestCase,
  getTestCase,
  importTestCases,
  listTestCases,
  updateTestCase,
} from "./services/test-cases";
import {
  createEvaluator,
  createVariant,
  deleteEvaluator,
  deleteVariant,
  listEvaluators,
  listVariants,
  updateEvaluator,
  updateVariant,
} from "./services/variants";

export type ApiResponse = { status: number; body: unknown };

type Handler = (
  ctx: Context,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
) => unknown;

type Route = { method: string; pattern: RegExp; keys: string[]; status: number; handler: Handler };

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler, status = 200): void {
  const keys: string[] = [];
  const source = path.replace(/\{(\w+)\}/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  routes.push({ method, pattern: new RegExp(`^${source}$`), keys, status, handler });
}

function missing(name: string): RequestValidationError {
  return new RequestValidationError([
    { loc: ["query", name], message: "Field required", type: "missing" },
  ]);
}

function sliceThreshold(query: URLSearchParams): number {
  const raw = query.get("slice_threshold");
  if (raw === null) return DEFAULT_SLICE_THRESHOLD;
  const value = Number(raw.trim());
  const fail = (message: string, type: string) =>
    new RequestValidationError([{ loc: ["query", "slice_threshold"], message, type }]);
  if (raw.trim() === "" || Number.isNaN(value)) {
    throw fail(
      "Input should be a valid number, unable to parse string as a number",
      "float_parsing",
    );
  }
  if (value < 0) throw fail("Input should be greater than or equal to 0", "greater_than_equal");
  if (value > 1) throw fail("Input should be less than or equal to 1", "less_than_equal");
  return value;
}

route("GET", "/health", () => ({ status: "ok" }));
route("GET", "/providers", (ctx) => ctx.providers);
route("GET", "/evaluator-types", (ctx) => ctx.registry.list());

route("GET", "/suites", (ctx) => listSuites(ctx));
route("POST", "/suites", (ctx, _p, _q, body) => createSuite(ctx, body), 201);
route("GET", "/suites/{suite_id}", (ctx, p) => getSuiteDetail(ctx, p.suite_id));
route("PATCH", "/suites/{suite_id}", (ctx, p, _q, body) => updateSuite(ctx, p.suite_id, body));
route("DELETE", "/suites/{suite_id}", (ctx, p) => deleteSuite(ctx, p.suite_id), 204);
route("PUT", "/suites/{suite_id}/baseline", (ctx, p, _q, body) =>
  setBaseline(ctx, p.suite_id, body),
);
route("DELETE", "/suites/{suite_id}/baseline", (ctx, p) => clearBaseline(ctx, p.suite_id));

route("GET", "/suites/{suite_id}/test-cases", (ctx, p, q) =>
  listTestCases(ctx, p.suite_id, q.get("tag"), q.get("q")),
);
route(
  "POST",
  "/suites/{suite_id}/test-cases",
  (ctx, p, _q, body) => createTestCase(ctx, p.suite_id, body),
  201,
);
route("POST", "/suites/{suite_id}/test-cases/import", (ctx, p, _q, body) =>
  importTestCases(ctx, p.suite_id, body),
);
route("GET", "/test-cases/{case_id}", (ctx, p) => getTestCase(ctx, p.case_id));
route("PATCH", "/test-cases/{case_id}", (ctx, p, _q, body) => updateTestCase(ctx, p.case_id, body));
route("DELETE", "/test-cases/{case_id}", (ctx, p) => deleteTestCase(ctx, p.case_id), 204);

route("GET", "/suites/{suite_id}/variants", (ctx, p) => listVariants(ctx, p.suite_id));
route(
  "POST",
  "/suites/{suite_id}/variants",
  (ctx, p, _q, body) => createVariant(ctx, p.suite_id, body),
  201,
);
route("PATCH", "/variants/{variant_id}", (ctx, p, _q, body) =>
  updateVariant(ctx, p.variant_id, body),
);
route("DELETE", "/variants/{variant_id}", (ctx, p) => deleteVariant(ctx, p.variant_id), 204);

route("GET", "/suites/{suite_id}/evaluators", (ctx, p) => listEvaluators(ctx, p.suite_id));
route(
  "POST",
  "/suites/{suite_id}/evaluators",
  (ctx, p, _q, body) => createEvaluator(ctx, p.suite_id, body),
  201,
);
route("PATCH", "/evaluators/{evaluator_id}", (ctx, p, _q, body) =>
  updateEvaluator(ctx, p.evaluator_id, body),
);
route(
  "DELETE",
  "/evaluators/{evaluator_id}",
  (ctx, p) => deleteEvaluator(ctx, p.evaluator_id),
  204,
);

route("GET", "/runs", (ctx, _p, q) => listRuns(ctx, q.get("suite_id")));
route("GET", "/suites/{suite_id}/runs", (ctx, p) => listRuns(ctx, p.suite_id));
route(
  "POST",
  "/suites/{suite_id}/runs",
  (ctx, p, _q, body) => createRun(ctx, p.suite_id, body),
  202,
);
route("GET", "/runs/{run_id}", (ctx, p) => getRunDetail(ctx, p.run_id));
route("DELETE", "/runs/{run_id}", (ctx, p) => deleteRun(ctx, p.run_id), 204);
route("POST", "/runs/{run_id}/cancel", (ctx, p) => cancelRun(ctx, p.run_id));
route("POST", "/runs/{run_id}/resume", (ctx, p, _q, body) => resumeRun(ctx, p.run_id, body));

route("GET", "/compare", (ctx, _p, q) => {
  const target = q.get("target");
  if (target === null) throw missing("target");
  return buildComparison(ctx, target, q.get("base"), sliceThreshold(q), q.get("slice_evaluator"));
});
route("GET", "/case-results", (ctx, _p, q) => {
  const testCaseId = q.get("test_case_id");
  const arms = q.getAll("arms");
  const issues = [];
  if (testCaseId === null)
    issues.push({ loc: ["query", "test_case_id"], message: "Field required", type: "missing" });
  if (arms.length === 0)
    issues.push({ loc: ["query", "arms"], message: "Field required", type: "missing" });
  if (issues.length) throw new RequestValidationError(issues);
  return getCaseResults(ctx, testCaseId as string, arms);
});

export async function dispatch(
  ctx: Context,
  method: string,
  url: string,
  body?: unknown,
): Promise<ApiResponse> {
  const [path, search = ""] = url.split("?", 2);
  const query = new URLSearchParams(search);
  const matching = routes.filter((r) => r.pattern.test(path));
  if (matching.length === 0) return { status: 404, body: { detail: "Not Found" } };
  const found = matching.find((r) => r.method === method.toUpperCase());
  if (!found) return { status: 405, body: { detail: "Method Not Allowed" } };

  const values = found.pattern.exec(path)!.slice(1).map(decodeURIComponent);
  const params = Object.fromEntries(found.keys.map((key, i) => [key, values[i]]));
  try {
    const result = await found.handler(ctx, params, query, body);
    return { status: found.status, body: found.status === 204 ? null : result };
  } catch (error) {
    if (error instanceof DomainError) {
      return { status: error.status, body: envelope(error.code, error.message, error.details) };
    }
    console.error("Demo API error", error);
    const message = error instanceof Error ? error.message : String(error);
    return { status: 500, body: envelope("internal_error", message) };
  }
}
