/** Port of `app/evaluators/output.py`: reading structured data out of outputs and fields. */

import { isDict, pyStrip } from "../py";
import { dumps, JsonDecodeError, loads } from "../pyjson";

const FENCE_RE = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/;
const PATH_TOKEN_RE = /([^.[\]]+)|\[(\d+)\]/g;

export class JsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParseError";
  }
}

export class PathNotFoundError extends Error {
  constructor(readonly path: string) {
    super(path);
    this.name = "PathNotFoundError";
  }
}

/** Parse model output as JSON, optionally unwrapping a markdown code fence first. */
export function parseJsonOutput(text: string, allowCodeFence = false): unknown {
  let candidate = pyStrip(text);
  if (allowCodeFence) {
    const fenced = FENCE_RE.exec(candidate);
    if (fenced) candidate = pyStrip(fenced[1]);
  }
  try {
    return loads(candidate);
  } catch (error) {
    if (!(error instanceof JsonDecodeError)) throw error;
    throw new JsonParseError(
      `Output is not valid JSON: ${error.msg} (line ${error.lineno}, column ${error.colno})`,
    );
  }
}

/** Resolve a dotted path with optional list indices, e.g. `items[0].name`. */
export function resolvePath(value: unknown, path: string): unknown {
  let current = value;
  for (const [, key, index] of path.matchAll(PATH_TOKEN_RE)) {
    if (key !== undefined) {
      if (!isDict(current) || !Object.hasOwn(current, key)) throw new PathNotFoundError(path);
      current = current[key];
    } else {
      const position = Number(index);
      if (!Array.isArray(current) || position >= current.length) throw new PathNotFoundError(path);
      current = current[position];
    }
  }
  return current;
}

export function toText(value: unknown): string {
  return typeof value === "string" ? value : dumps(value, { indent: 2, ensureAscii: false });
}
