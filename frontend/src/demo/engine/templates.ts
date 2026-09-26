/** Port of `app/domain/templates.py`: `{{ path }}` placeholders resolved against a case input. */

import { isDict } from "./py";
import { dumps } from "./pyjson";

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\p{L}\p{N}_.[\]]*)\s*\}\}/gu;
const PATH_TOKEN_RE = /([^.[\]]+)|\[(\d+)\]/g;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export function templateVariables(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER_RE), (m) => m[1]))];
}

export function renderTemplate(template: string, value: unknown): string {
  return template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const resolved = path === "input" ? value : resolve(value, path);
    return typeof resolved === "string" ? resolved : dumps(resolved, { indent: 2 });
  });
}

function resolve(value: unknown, path: string): unknown {
  let current = value;
  for (const [, key, index] of path.matchAll(PATH_TOKEN_RE)) {
    if (key !== undefined && isDict(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else if (index !== undefined && Array.isArray(current) && Number(index) < current.length) {
      current = current[Number(index)];
    } else {
      throw new TemplateError(`Template variable '{{ ${path} }}' is missing from the input`);
    }
  }
  return current;
}
