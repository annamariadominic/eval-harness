/** Test-only access to the golden fixtures exported by `backend/app/demo/export.py`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(process.cwd(), "src", "demo", "__fixtures__");
const cache = new Map<string, unknown>();

function load<T>(name: string): T {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(join(FIXTURES, name), "utf8")));
  return cache.get(name) as T;
}

// The fixtures are data from Python; tests narrow what they read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Golden = any;

export const unitGolden = () => load<Golden>("unit-golden.json");
export const apiGolden = () => load<Golden>("api-golden.json");
