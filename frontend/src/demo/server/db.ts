/**
 * The in-browser "database": the backend's tables as arrays of plain rows, with the foreign-key
 * cascade rules of `app/db/models.py`. Rows keep the snapshot's column names, so services read
 * like their SQLAlchemy originals and the tables serialise straight back to the snapshot format.
 */

export type Row = Record<string, unknown> & { id: string };

export const TABLES = [
  "eval_suites",
  "test_cases",
  "variants",
  "evaluators",
  "runs",
  "run_cases",
  "run_variants",
  "run_evaluators",
  "results",
  "evaluator_scores",
] as const;

export type TableName = (typeof TABLES)[number];
export type Tables = Record<TableName, Row[]>;

/** Naive UTC ISO timestamps, as the backend returns them for stored rows. */
export function utcnow(): string {
  return new Date().toISOString().replace("Z", "000");
}

/** Readable, prefixed identifiers like the backend's `new_id` (`suite_3f9a1c2b7d4e`). */
export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** `ON DELETE CASCADE` children of each table, as declared in the ORM models. */
const CASCADES: Partial<Record<TableName, Array<[TableName, string]>>> = {
  eval_suites: [
    ["test_cases", "suite_id"],
    ["variants", "suite_id"],
    ["evaluators", "suite_id"],
    ["runs", "suite_id"],
  ],
  runs: [
    ["run_cases", "run_id"],
    ["run_variants", "run_id"],
    ["run_evaluators", "run_id"],
    ["results", "run_id"],
  ],
  run_cases: [["results", "run_case_id"]],
  run_variants: [["results", "run_variant_id"]],
  run_evaluators: [["evaluator_scores", "run_evaluator_id"]],
  results: [["evaluator_scores", "result_id"]],
};

export class Database {
  private listeners = new Set<() => void>();

  constructor(public tables: Tables) {}

  static empty(): Database {
    return new Database(Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as Tables);
  }

  /** Called after every change, so persistence can schedule a save. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.listeners) listener();
  }

  rows<T extends Row = Row>(table: TableName): T[] {
    return this.tables[table] as T[];
  }

  get<T extends Row = Row>(table: TableName, id: string): T | undefined {
    return this.tables[table].find((row) => row.id === id) as T | undefined;
  }

  where<T extends Row = Row>(table: TableName, column: string, value: unknown): T[] {
    return this.tables[table].filter((row) => row[column] === value) as T[];
  }

  insert<T extends Row>(table: TableName, row: T): T {
    this.tables[table].push(row);
    this.changed();
    return row;
  }

  /** Delete rows matching `predicate`, cascading to their children like the database does. */
  delete(table: TableName, predicate: (row: Row) => boolean): void {
    const doomed = this.tables[table].filter(predicate);
    if (doomed.length === 0) return;
    const ids = new Set(doomed.map((row) => row.id));
    this.tables[table] = this.tables[table].filter((row) => !ids.has(row.id));
    for (const [child, column] of CASCADES[table] ?? []) {
      this.delete(child, (row) => ids.has(row[column] as string));
    }
    if (table === "runs" || table === "run_variants") {
      // eval_suites.baseline_* use ON DELETE SET NULL.
      const column = table === "runs" ? "baseline_run_id" : "baseline_run_variant_id";
      for (const suite of this.tables.eval_suites) {
        if (ids.has(suite[column] as string)) suite[column] = null;
      }
    }
    this.changed();
  }
}

/** Stable sort by a string column (ISO timestamps sort lexicographically). */
export function orderBy<T extends Row>(rows: T[], column: string, descending = false): T[] {
  const sign = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = String(a[column] ?? "");
    const y = String(b[column] ?? "");
    return x < y ? -sign : x > y ? sign : 0;
  });
}
