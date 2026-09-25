/**
 * Parsing for free-form value editors: text that looks like JSON (an object, array, number,
 * boolean, or quoted string) is parsed; anything else is kept as a plain string.
 */

export type ParsedValue = { ok: true; value: unknown } | { ok: false; error: string };

const JSON_START = /^[[{"]|^-?\d|^(true|false|null)$/;

export function parseLooseValue(text: string): ParsedValue {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!JSON_START.test(trimmed)) return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    // Text that merely starts with a digit ("42 widgets") is still a valid plain string.
    if (/^-?\d/.test(trimmed) && !/^[[{"]/.test(trimmed)) return { ok: true, value: text };
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
}

export function parseJsonObject(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Expected a JSON object" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
}

export function toEditorText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function parseTagList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}
