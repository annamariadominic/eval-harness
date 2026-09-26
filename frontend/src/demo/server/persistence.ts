/**
 * Keeps each visitor's sandbox in their own browser (IndexedDB), so edits and runs survive a
 * reload. Nothing ever leaves the browser. Falls back to memory only when storage is unavailable
 * (private windows, blocked site data), in which case the demo still works for the session.
 */

import type { Tables } from "./db";

export type SavedState = { version: string; tables: Tables };

export interface StateStore {
  load(): Promise<SavedState | null>;
  save(state: SavedState): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "eval-harness-demo";
const STORE = "state";
const KEY = "sandbox";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDbStore implements StateStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async load(): Promise<SavedState | null> {
    return ((await request((await this.store("readonly")).get(KEY))) as SavedState) ?? null;
  }

  async save(state: SavedState): Promise<void> {
    await request((await this.store("readwrite")).put(state, KEY));
  }

  async clear(): Promise<void> {
    await request((await this.store("readwrite")).delete(KEY));
  }
}

export class MemoryStore implements StateStore {
  private state: SavedState | null = null;

  async load() {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: SavedState) {
    this.state = structuredClone(state);
  }

  async clear() {
    this.state = null;
  }
}

/** IndexedDB when it works, memory otherwise; storage errors never break the demo. */
export class ResilientStore implements StateStore {
  private fallback = new MemoryStore();
  private primary: StateStore | null;

  constructor(primary: StateStore | null) {
    this.primary = primary;
  }

  private async attempt<T>(action: (s: StateStore) => Promise<T>): Promise<T> {
    if (this.primary) {
      try {
        return await action(this.primary);
      } catch {
        this.primary = null;
      }
    }
    return action(this.fallback);
  }

  load() {
    return this.attempt((s) => s.load());
  }

  save(state: SavedState) {
    return this.attempt((s) => s.save(state));
  }

  clear() {
    return this.attempt((s) => s.clear());
  }
}

export function browserStore(): StateStore {
  const available = typeof indexedDB !== "undefined";
  return new ResilientStore(available ? new IndexedDbStore() : null);
}

/** Coalesces bursts of changes (a running evaluation writes constantly) into periodic saves. */
export class Saver {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly snapshot: () => SavedState,
    private readonly delayMs = 500,
  ) {}

  schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.store.save(structuredClone(this.snapshot()));
  }
}
