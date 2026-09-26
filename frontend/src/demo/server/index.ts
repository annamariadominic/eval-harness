/**
 * The demo's in-browser backend.
 *
 * In demo builds (`NEXT_PUBLIC_DEMO_MODE=1`) the API client sends every `/api/*` request here
 * instead of over the network. Each visitor gets a private sandbox seeded from the exported
 * snapshot (including runs recorded against real models) and saved in their own browser; live
 * runs use the in-browser mock provider, so the demo needs no server and no API keys.
 */

import {
  EvaluatorRegistry,
  MockProvider,
  PricingTable,
  ProviderRegistry,
  type EvaluatorTypeInfo,
  type ModelPrice,
} from "../engine";
import { DEFAULT_SETTINGS, type Context, type ProviderInfo } from "./context";
import { Database, type Tables } from "./db";
import { browserStore, Saver, type StateStore } from "./persistence";
import { dispatch, type ApiResponse } from "./router";
import { RunExecutor, RunManager } from "./runner";

export type Snapshot = {
  format: number;
  version: string;
  tables: Tables;
  pricing: { models: ModelPrice[] };
  meta: { providers: ProviderInfo[]; evaluator_types: EvaluatorTypeInfo[] };
};

export type ServerOptions = {
  store: StateStore;
  /** Multiplier on the mock provider's simulated latency (0 runs instantly, for tests). */
  latencyScale?: number;
  sleep?: (seconds: number) => Promise<void>;
};

export class DemoServer {
  readonly ctx: Context;
  private readonly saver: Saver;

  private constructor(
    private readonly snapshot: Snapshot,
    tables: Tables,
    private readonly store: StateStore,
    options: ServerOptions,
  ) {
    const db = new Database(tables);
    const registry = new EvaluatorRegistry(snapshot.meta.evaluator_types);
    const pricing = PricingTable.fromJson(snapshot.pricing);
    const noWait = options.sleep;
    const providers = new ProviderRegistry({
      mock: new MockProvider(options.latencyScale ?? 1.0, noWait),
    });
    const executor = new RunExecutor({ db, providers, pricing, registry, sleep: noWait });
    const manager = new RunManager(executor, db);
    this.ctx = {
      db,
      registry,
      pricing,
      providers: snapshot.meta.providers,
      manager,
      settings: DEFAULT_SETTINGS,
    };
    this.saver = new Saver(store, () => ({
      version: snapshot.version,
      tables: this.ctx.db.tables,
    }));
    db.onChange(() => this.saver.schedule());
    manager.recoverInterrupted();
  }

  /** Restore the visitor's saved sandbox, or start fresh from the snapshot. */
  static async start(snapshot: Snapshot, options: ServerOptions): Promise<DemoServer> {
    const saved = await options.store.load();
    const tables =
      saved && saved.version === snapshot.version ? saved.tables : structuredClone(snapshot.tables);
    return new DemoServer(snapshot, tables, options.store, options);
  }

  handle(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    return dispatch(this.ctx, method, path, body);
  }

  flush(): Promise<void> {
    return this.saver.flush();
  }

  /** Discard every change and return to the snapshot. */
  async reset(): Promise<void> {
    for (const run of this.ctx.db.rows("runs")) await this.ctx.manager.cancel(run.id);
    this.ctx.db.tables = structuredClone(this.snapshot.tables);
    await this.store.clear();
    this.ctx.db.changed();
  }
}

let server: Promise<DemoServer> | null = null;

function browserServer(): Promise<DemoServer> {
  server ??= (async () => {
    const response = await fetch("/demo/snapshot.json");
    if (!response.ok) throw new Error(`Could not load the demo data (${response.status})`);
    const instance = await DemoServer.start((await response.json()) as Snapshot, {
      store: browserStore(),
    });
    const flush = () => void instance.flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    return instance;
  })();
  return server;
}

/** A `fetch`-shaped entry point for the API client. */
export async function demoFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const { status, body: payload } = await (await browserServer()).handle(method, path, body);
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function resetDemo(): Promise<void> {
  await (await browserServer()).reset();
}
