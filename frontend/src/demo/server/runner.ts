/**
 * Ports of `app/runner/executor.py` and `app/runner/manager.py`, running in the browser.
 *
 * Same work model as the backend: every (case x variant) item is a result row created up front
 * as `pending`; a pool of `concurrency` workers drains them, each generating and then running
 * every evaluator, and committing the item in one step. Progress is read from the rows, so the
 * UI's polling works unchanged, and an interrupted run can be resumed item by item.
 *
 * Cancellation mirrors asyncio task cancellation: in-flight awaits are abandoned and nothing
 * after them is committed, so a cancelled item is left `running` and settled as `cancelled`.
 */

import {
  aggregateArm,
  CallFailedError,
  EvaluatorError,
  PricedModelCaller,
  renderTemplate,
  retryPolicy,
  TemplateError,
  type EvaluationSample,
  type Evaluator,
  type EvaluatorRegistry,
  type Message,
  type PricingTable,
  type ProviderRegistry,
} from "../engine";
import { newId, utcnow, type Database, type Row } from "./db";
import { loadArmRecords } from "./services/comparisons";

export class CancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "CancelledError";
  }
}

/** A cancellation signal that can interrupt awaits, like `asyncio.Task.cancel()`. */
export class CancelToken {
  cancelled = false;
  private readonly waiters = new Set<(error: CancelledError) => void>();

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const reject of this.waiters) reject(new CancelledError());
    this.waiters.clear();
  }

  /** Resolve with `promise`, or reject with {@link CancelledError} if cancelled first. */
  race<T>(promise: Promise<T>): Promise<T> {
    if (this.cancelled) return Promise.reject(new CancelledError());
    return new Promise<T>((resolve, reject) => {
      this.waiters.add(reject);
      promise.then(
        (value) => {
          this.waiters.delete(reject);
          if (this.cancelled) reject(new CancelledError());
          else resolve(value);
        },
        (error) => {
          this.waiters.delete(reject);
          reject(this.cancelled ? new CancelledError() : error);
        },
      );
    });
  }
}

export function buildMessages(variant: Row, caseInput: unknown): Message[] {
  const messages: Message[] = [];
  if ((variant.system_prompt as string).trim()) {
    messages.push({ role: "system", content: variant.system_prompt as string });
  }
  messages.push({
    role: "user",
    content: renderTemplate(variant.user_template as string, caseInput),
  });
  return messages;
}

const errorText = (error: unknown) =>
  error instanceof Error
    ? `${error.name === "Error" ? "Error" : error.name}: ${error.message}`
    : String(error);

export type RunnerDeps = {
  db: Database;
  providers: ProviderRegistry;
  pricing: PricingTable;
  registry: EvaluatorRegistry;
  sleep?: (seconds: number) => Promise<void>;
};

export class RunExecutor {
  constructor(private readonly deps: RunnerDeps) {}

  async execute(runId: string, token: CancelToken): Promise<void> {
    const { db } = this.deps;
    const run = db.get("runs", runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    // Rows left 'running' by an interrupted session are safe to redo: they never committed.
    for (const result of db.where("results", "run_id", runId)) {
      if (result.status === "running") result.status = "pending";
    }
    run.status = "running";
    run.error = null;
    run.started_at ??= utcnow();
    run.finished_at = null;
    db.changed();

    const cases = new Map(db.where("run_cases", "run_id", runId).map((c) => [c.id, c]));
    const variants = new Map(db.where("run_variants", "run_id", runId).map((v) => [v.id, v]));
    const pending = db
      .where("results", "run_id", runId)
      .filter((r) => r.status === "pending")
      .sort(
        (a, b) =>
          (cases.get(a.run_case_id as string)!.position as number) -
            (cases.get(b.run_case_id as string)!.position as number) ||
          (variants.get(a.run_variant_id as string)!.position as number) -
            (variants.get(b.run_variant_id as string)!.position as number),
      )
      .map((r) => r.id);

    const sleep = (seconds: number) =>
      token.race(
        this.deps.sleep
          ? this.deps.sleep(seconds)
          : new Promise<void>((r) => setTimeout(r, seconds * 1000)),
      );
    const caller = new PricedModelCaller(
      this.deps.providers,
      this.deps.pricing,
      retryPolicy(run.max_attempts as number),
      sleep,
    );
    const call: typeof caller.call = (provider, messages, config) =>
      token.race(caller.call(provider, messages, config));
    const evaluators: Array<[Row, Evaluator | null, string | null]> = db
      .where("run_evaluators", "run_id", runId)
      .sort((a, b) => (a.position as number) - (b.position as number))
      .map((runEvaluator) => {
        try {
          return [
            runEvaluator,
            this.deps.registry.build(runEvaluator.type as string, runEvaluator.config, call),
            null,
          ];
        } catch (error) {
          return [runEvaluator, null, `Could not build evaluator: ${(error as Error).message}`];
        }
      });

    const queue = [...pending];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        await this.process(id, cases, variants, evaluators, call, token);
      }
    };
    const workers = Math.max(1, Math.min(run.concurrency as number, pending.length));
    try {
      await Promise.all(Array.from({ length: workers }, worker));
    } catch (error) {
      if (error instanceof CancelledError) {
        token.cancel();
        this.finish(runId, "cancelled");
        throw error;
      }
      token.cancel();
      this.finish(runId, "failed", errorText(error));
      return;
    }
    this.finish(runId, "completed");
  }

  private async process(
    resultId: string,
    cases: Map<string, Row>,
    variants: Map<string, Row>,
    evaluators: Array<[Row, Evaluator | null, string | null]>,
    call: PricedModelCaller["call"],
    token: CancelToken,
  ): Promise<void> {
    const { db } = this.deps;
    const result = db.get("results", resultId);
    if (!result || result.status !== "pending") return;
    if (token.cancelled) throw new CancelledError();
    result.status = "running";
    result.started_at = utcnow();
    db.changed();

    const runCase = cases.get(result.run_case_id as string)!;
    const variant = variants.get(result.run_variant_id as string)!;
    const patch = await this.generate(runCase, variant, call);
    const scores: Row[] = [];
    if (patch.status === "succeeded") {
      const sample: EvaluationSample = {
        input: runCase.input,
        expected: runCase.expected,
        output: (patch.output as string | null) ?? "",
      };
      for (const [runEvaluator, evaluator, buildError] of evaluators) {
        scores.push(await this.evaluate(resultId, runEvaluator, evaluator, buildError, sample));
      }
    } else {
      for (const [runEvaluator] of evaluators) {
        scores.push(
          scoreRow(resultId, runEvaluator.id, {
            status: "skipped",
            reason: "Not evaluated: the generation failed",
          }),
        );
      }
    }
    // Commit the item in one step, like the backend's per-item transaction.
    Object.assign(result, patch, { finished_at: utcnow() });
    for (const score of scores) db.insert("evaluator_scores", score);
    db.changed();
  }

  private async generate(
    runCase: Row,
    variant: Row,
    call: PricedModelCaller["call"],
  ): Promise<Record<string, unknown>> {
    let messages: Message[];
    try {
      messages = buildMessages(variant, runCase.input);
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      return { status: "failed", error_type: "template_error", error_message: error.message };
    }
    const requestMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    try {
      const outcome = await call(variant.provider as string, messages, {
        model: variant.model as string,
        temperature: variant.temperature as number | null,
        max_tokens: variant.max_tokens as number,
        settings: variant.settings as Record<string, unknown>,
      });
      return {
        request_messages: requestMessages,
        status: "succeeded",
        output: outcome.result.output,
        response_model: outcome.result.model,
        latency_ms: outcome.result.latency_ms,
        input_tokens: outcome.result.input_tokens,
        output_tokens: outcome.result.output_tokens,
        cost_usd: outcome.cost_usd,
        attempts: outcome.attempts,
      };
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      if (error instanceof CallFailedError) {
        return {
          request_messages: requestMessages,
          status: "failed",
          attempts: error.attempts,
          error_type: error.error.kind,
          error_message: error.error.message,
        };
      }
      return {
        request_messages: requestMessages,
        status: "failed",
        error_type: "internal_error",
        error_message: errorText(error),
      };
    }
  }

  private async evaluate(
    resultId: string,
    runEvaluator: Row,
    evaluator: Evaluator | null,
    buildError: string | null,
    sample: EvaluationSample,
  ): Promise<Row> {
    if (evaluator === null) {
      return scoreRow(resultId, runEvaluator.id, { status: "failed", error_message: buildError });
    }
    try {
      const outcome = await evaluator.evaluate(sample);
      return scoreRow(resultId, runEvaluator.id, {
        status: "succeeded",
        score: outcome.score,
        passed: outcome.passed,
        reason: outcome.reason,
        details: outcome.details,
        ...(outcome.usage ?? {}),
      });
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      let message: string;
      if (error instanceof CallFailedError) {
        message = `Judge call failed after ${error.attempts} attempt(s): ${error.message}`;
      } else if (error instanceof EvaluatorError) {
        message = error.message;
      } else {
        message = errorText(error);
      }
      return scoreRow(resultId, runEvaluator.id, { status: "failed", error_message: message });
    }
  }

  private finish(runId: string, status: string, error: string | null = null): void {
    const { db } = this.deps;
    const run = db.get("runs", runId);
    if (!run) return;
    if (status !== "completed") {
      for (const result of db.where("results", "run_id", runId)) {
        if (result.status === "pending" || result.status === "running") result.status = "cancelled";
      }
    }
    run.summary = computeRunSummary(db, runId);
    run.status = status;
    run.error = error;
    run.finished_at = utcnow();
    db.changed();
  }
}

function scoreRow(resultId: string, runEvaluatorId: string, values: Record<string, unknown>): Row {
  return {
    id: newId("score"),
    result_id: resultId,
    run_evaluator_id: runEvaluatorId,
    status: "succeeded",
    score: null,
    passed: null,
    reason: "",
    details: {},
    latency_ms: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    error_message: null,
    created_at: utcnow(),
    ...values,
  };
}

export function computeRunSummary(db: Database, runId: string) {
  const arms: Record<string, unknown> = {};
  const variants = db
    .where("run_variants", "run_id", runId)
    .sort((a, b) => (a.position as number) - (b.position as number));
  for (const variant of variants) arms[variant.id] = aggregateArm(loadArmRecords(db, variant.id));
  return { arms };
}

/** In-page scheduler: one background execution per active run. */
export class RunManager {
  private readonly active = new Map<string, { token: CancelToken; done: Promise<void> }>();

  constructor(
    private readonly executor: RunExecutor,
    private readonly db: Database,
  ) {}

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  start(runId: string): void {
    if (this.isActive(runId)) return;
    const token = new CancelToken();
    // Like asyncio.create_task, execution starts on a later tick, so the response that
    // launched the run still reports it as queued.
    const done = Promise.resolve()
      .then(() => this.executor.execute(runId, token))
      .catch(() => undefined)
      .finally(() => this.active.delete(runId));
    this.active.set(runId, { token, done });
  }

  async cancel(runId: string): Promise<boolean> {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.token.cancel();
    await entry.done;
    return true;
  }

  async wait(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  /** Runs left active when the page closed are marked interrupted (and are resumable). */
  recoverInterrupted(): number {
    const stale = this.db
      .rows("runs")
      .filter((r) => r.status === "queued" || r.status === "running");
    for (const run of stale) {
      for (const result of this.db.where("results", "run_id", run.id)) {
        if (result.status === "running") result.status = "pending";
      }
      run.status = "interrupted";
      run.error = "The page was closed while this run was in progress. Resume to finish it.";
    }
    if (stale.length) this.db.changed();
    return stale.length;
  }
}
