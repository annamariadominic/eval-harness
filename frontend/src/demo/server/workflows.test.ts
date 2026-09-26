import { describe, expect, it } from "vitest";

import snapshotJson from "../../../public/demo/snapshot.json";
import { DemoServer, type Snapshot } from ".";
import type { Row } from "./db";
import { MemoryStore } from "./persistence";

const snapshot = snapshotJson as unknown as Snapshot;
const noSleep = async () => {};

async function start(options: Partial<Parameters<typeof DemoServer.start>[1]> = {}) {
  return DemoServer.start(structuredClone(snapshot), {
    store: new MemoryStore(),
    latencyScale: 0,
    sleep: noSleep,
    ...options,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(server: DemoServer, method: string, path: string, body?: unknown) {
  const response = await server.handle(method, path, body);
  return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) as Json };
}

async function finished(server: DemoServer, runId: string) {
  await server.ctx.manager.wait(runId);
  return (await call(server, "GET", `/runs/${runId}`)).body;
}

const RESULT_FIELDS = [
  "status",
  "output",
  "request_messages",
  "response_model",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "attempts",
  "error_type",
  "error_message",
];
const SCORE_FIELDS = [
  "status",
  "score",
  "passed",
  "reason",
  "details",
  "latency_ms",
  "input_tokens",
  "output_tokens",
  "cost_usd",
  "error_message",
];

/** Everything a run produced, keyed by (test case, variant, evaluator) rather than by ids. */
function producedBy(tables: Snapshot["tables"], runId: string) {
  const cases = new Map(tables.run_cases.map((c) => [c.id, c]));
  const variants = new Map(tables.run_variants.map((v) => [v.id, v]));
  const evaluators = new Map(tables.run_evaluators.map((e) => [e.id, e]));
  const pick = (row: Row, fields: string[]) => Object.fromEntries(fields.map((f) => [f, row[f]]));
  return tables.results
    .filter((r) => r.run_id === runId)
    .map((r) => ({
      case: cases.get(r.run_case_id as string)!.test_case_id,
      variant: variants.get(r.run_variant_id as string)!.variant_id,
      result: pick(r, RESULT_FIELDS),
      scores: tables.evaluator_scores
        .filter((s) => s.result_id === r.id)
        .map((s) => ({
          evaluator: evaluators.get(s.run_evaluator_id as string)!.evaluator_id,
          ...pick(s, SCORE_FIELDS),
        }))
        .sort((a, b) => String(a.evaluator).localeCompare(String(b.evaluator))),
    }))
    .sort((a, b) => `${a.case}${a.variant}`.localeCompare(`${b.case}${b.variant}`));
}

describe("live runs reproduce the Python runner", () => {
  it("replays every seeded mock run with identical outputs, scores, costs, and retries", async () => {
    const server = await start();
    const seeded = [...snapshot.tables.runs].sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at)),
    );
    for (const original of seeded) {
      const variantIds = snapshot.tables.run_variants
        .filter((v) => v.run_id === original.id)
        .sort((a, b) => (a.position as number) - (b.position as number))
        .map((v) => v.variant_id);
      const evaluatorIds = snapshot.tables.run_evaluators
        .filter((e) => e.run_id === original.id)
        .sort((a, b) => (a.position as number) - (b.position as number))
        .map((e) => e.evaluator_id);
      const created = await call(server, "POST", `/suites/${original.suite_id}/runs`, {
        variant_ids: variantIds,
        evaluator_ids: evaluatorIds,
        concurrency: original.concurrency,
      });
      expect(created.status).toBe(202);
      const run = await finished(server, created.body.id);
      expect(run.status).toBe("completed");
      expect(producedBy(server.ctx.db.tables, run.id)).toEqual(
        producedBy(snapshot.tables, original.id),
      );
      expect(run.summary.arms[run.variants[0].id]).toEqual(
        (original.summary as Json).arms[
          snapshot.tables.run_variants.find((v) => v.run_id === original.id && v.position === 0)!.id
        ],
      );
    }
  });
});

describe("editing a suite end to end", () => {
  it("creates a suite, validates input like the backend, runs it, and compares arms", async () => {
    const server = await start();

    expect((await call(server, "POST", "/suites", { name: "" })).body).toEqual({
      error: {
        code: "validation_error",
        message: "Request validation failed",
        details: [
          {
            loc: ["body", "name"],
            message: "String should have at least 1 character",
            type: "string_too_short",
          },
        ],
      },
    });
    const suite = (await call(server, "POST", "/suites", { name: "Capitals" })).body;
    expect(suite).toMatchObject({ name: "Capitals", test_case_count: 0, run_count: 0 });

    const bad = await call(server, "POST", `/suites/${suite.id}/test-cases`, { input: "" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0]).toMatchObject({
      loc: ["body", "input"],
      message: "Value error, input must not be empty",
    });

    const imported = await call(server, "POST", `/suites/${suite.id}/test-cases/import`, {
      cases: [
        {
          key: "fr",
          input: { q: "Capital of France?" },
          expected: "Paris",
          tags: [" Europe ", "EUROPE"],
        },
        { key: "jp", input: { q: "Capital of Japan?" }, expected: "Tokyo", tags: ["Asia"] },
        { key: "fr", input: { q: "Duplicate" }, extra: 1 },
      ],
    });
    expect(imported.body).toMatchObject({ valid: false, created: 0 });
    expect(imported.body.errors).toEqual([
      {
        index: 2,
        field: "extra",
        message: "Unknown field 'extra'. Allowed: expected, input, key, metadata, tags",
      },
      { index: 2, field: "key", message: "Duplicate key 'fr' (first used by case 0)" },
    ]);
    // Like the backend, the preview still lists the flagged duplicate; import the first two.
    const ok = await call(server, "POST", `/suites/${suite.id}/test-cases/import`, {
      cases: imported.body.preview.slice(0, 2),
    });
    expect(ok.body).toMatchObject({ valid: true, created: 2, tag_counts: { europe: 1, asia: 1 } });
    expect(
      (await call(server, "POST", `/suites/${suite.id}/test-cases`, { key: "jp", input: "x" }))
        .status,
    ).toBe(409);

    const unknown = await call(server, "POST", `/suites/${suite.id}/variants`, {
      name: "v",
      provider: "nope",
      model: "m",
      user_template: "{{ q }}",
    });
    expect(unknown.body.error.message).toBe(
      "Unknown provider 'nope'. Available: anthropic, mock, openai",
    );
    const small = (
      await call(server, "POST", `/suites/${suite.id}/variants`, {
        name: "Small",
        provider: "mock",
        model: "mock-small",
        user_template:
          "Question: {{ q }}\n\n[1] Paris is the capital of France. [2] Tokyo is the capital of Japan.",
      })
    ).body;
    expect(small.template_variables).toEqual(["q"]);
    const large = (
      await call(server, "POST", `/suites/${suite.id}/variants`, {
        ...small,
        name: "Large",
        model: "mock-large",
      })
    ).body;

    const badConfig = await call(server, "POST", `/suites/${suite.id}/evaluators`, {
      name: "Contains answer",
      type: "contains",
      config: { mode: "some" },
    });
    expect(badConfig.body.error).toEqual({
      code: "invalid_request",
      message: "Invalid configuration for Contains evaluator",
      details: [{ loc: ["mode"], message: "Input should be 'all' or 'any'" }],
    });
    const evaluator = (
      await call(server, "POST", `/suites/${suite.id}/evaluators`, {
        name: "Contains answer",
        type: "contains",
        config: {},
      })
    ).body;
    expect(evaluator.config).toEqual({
      values: [],
      expected_path: null,
      mode: "all",
      case_sensitive: false,
    });

    const run = (
      await call(server, "POST", `/suites/${suite.id}/runs`, {
        variant_ids: [small.id, large.id],
        evaluator_ids: [evaluator.id],
      })
    ).body;
    expect(run).toMatchObject({ name: "Run 1", status: "queued", case_count: 2 });
    const done = await finished(server, run.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toMatchObject({ total: 4, succeeded: 4, pending: 0 });

    const report = (
      await call(
        server,
        "GET",
        `/compare?target=${done.variants[1].id}&base=${done.variants[0].id}`,
      )
    ).body;
    expect(report.coverage).toEqual({ shared: 2, base_only: 0, target_only: 0 });
    expect(report.cases).toHaveLength(2);

    const baseline = await call(server, "PUT", `/suites/${suite.id}/baseline`, { run_id: run.id });
    expect(baseline.body.error.message).toBe(
      "This run evaluated several variants; choose which one is the baseline",
    );
    const withBaseline = (
      await call(server, "PUT", `/suites/${suite.id}/baseline`, {
        run_id: run.id,
        run_variant_id: done.variants[0].id,
      })
    ).body;
    expect(withBaseline.baseline.run_variant_id).toBe(done.variants[0].id);

    expect((await call(server, "DELETE", `/runs/${run.id}`)).status).toBe(204);
    expect((await call(server, "GET", `/suites/${suite.id}`)).body.baseline).toBeNull();
    expect(server.ctx.db.tables.results.some((r) => r.run_id === run.id)).toBe(false);

    expect((await call(server, "DELETE", `/suites/${suite.id}`)).status).toBe(204);
    expect(server.ctx.db.tables.test_cases.some((c) => c.suite_id === suite.id)).toBe(false);
    expect(server.ctx.db.tables.variants.some((v) => v.suite_id === suite.id)).toBe(false);
  });

  it("refuses to run real providers and explains why", async () => {
    const server = await start();
    const claude = snapshot.tables.variants.find((v) => v.provider === "anthropic")!;
    const response = await call(server, "POST", `/suites/${claude.suite_id}/runs`, {
      variant_ids: [claude.id],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toBe(
      `Variant '${claude.name}': Provider 'anthropic' is not available in this demo: its results were recorded in advance`,
    );
  });

  it("answers unknown routes and methods like FastAPI", async () => {
    const server = await start();
    expect(await call(server, "GET", "/nope")).toEqual({
      status: 404,
      body: { detail: "Not Found" },
    });
    expect(await call(server, "PUT", "/suites")).toEqual({
      status: 405,
      body: { detail: "Method Not Allowed" },
    });
    expect((await call(server, "GET", "/compare")).body.error.details).toEqual([
      { loc: ["query", "target"], message: "Field required", type: "missing" },
    ]);
  });
});

describe("demo limits", () => {
  it("caps imports and run sizes so a tab stays responsive", async () => {
    const server = await start();
    server.ctx.settings = { ...server.ctx.settings, max_import_cases: 2, max_generations: 3 };
    const suite = snapshot.tables.eval_suites[0];
    const tooMany = await call(server, "POST", `/suites/${suite.id}/test-cases/import`, {
      cases: [{ input: "a" }, { input: "b" }, { input: "c" }],
      dry_run: true,
    });
    expect(tooMany.body.error.message).toBe("The demo imports at most 2 test cases at a time");
    const variant = snapshot.tables.variants.find((v) => v.suite_id === suite.id)!;
    const big = await call(server, "POST", `/suites/${suite.id}/runs`, {
      variant_ids: [variant.id],
    });
    expect(big.body.error.message).toMatch(/^The demo runs at most 3 generations at a time/);
  });
});

describe("cancel and resume", () => {
  it("cancels mid-run without committing partial items, then resumes to completion", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = await start({ latencyScale: 1, sleep: () => gate });
    const suite = snapshot.tables.eval_suites[0];
    const variant = snapshot.tables.variants.find(
      (v) => v.suite_id === suite.id && v.provider === "mock",
    )!;
    const run = (
      await call(server, "POST", `/suites/${suite.id}/runs`, { variant_ids: [variant.id] })
    ).body;

    const cancelled = await call(server, "POST", `/runs/${run.id}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.progress.succeeded).toBe(0);
    expect(cancelled.body.progress.cancelled).toBe(cancelled.body.progress.total);
    expect((await call(server, "POST", `/runs/${run.id}/cancel`)).body.error.message).toBe(
      "Run is already cancelled",
    );

    release();
    const resumed = await call(server, "POST", `/runs/${run.id}/resume`, {});
    expect(resumed.body.status).toBe("queued");
    const done = await finished(server, run.id);
    expect(done.status).toBe("completed");
    expect(done.progress.succeeded).toBe(done.progress.total);
    expect((await call(server, "POST", `/runs/${run.id}/resume`, {})).body.error.message).toBe(
      "Nothing to resume: every generation has already completed",
    );
  });
});

describe("persistence", () => {
  it("restores a visitor's sandbox, and starts fresh when the snapshot changes", async () => {
    const store = new MemoryStore();
    const first = await start({ store });
    await call(first, "POST", "/suites", { name: "Mine" });
    await first.flush();

    const again = await start({ store });
    expect((await call(again, "GET", "/suites")).body.map((s: Json) => s.name)).toContain("Mine");

    const newer = await DemoServer.start(
      { ...structuredClone(snapshot), version: "next" },
      { store, latencyScale: 0 },
    );
    expect((await call(newer, "GET", "/suites")).body.map((s: Json) => s.name)).not.toContain(
      "Mine",
    );
  });

  it("marks runs left running by a closed page as interrupted and resumable", async () => {
    const store = new MemoryStore();
    const tables = structuredClone(snapshot.tables);
    tables.runs[0].status = "running";
    tables.results.find((r) => r.run_id === tables.runs[0].id)!.status = "running";
    await store.save({ version: snapshot.version, tables });

    const server = await start({ store });
    const run = (await call(server, "GET", `/runs/${tables.runs[0].id}`)).body;
    expect(run.status).toBe("interrupted");
    expect(run.error).toMatch(/Resume to finish it/);
    expect(run.progress.running).toBe(0);
  });

  it("resets to the snapshot", async () => {
    const server = await start();
    await call(server, "POST", "/suites", { name: "Temporary" });
    await server.reset();
    expect((await call(server, "GET", "/suites")).body).toHaveLength(
      snapshot.tables.eval_suites.length,
    );
  });
});
