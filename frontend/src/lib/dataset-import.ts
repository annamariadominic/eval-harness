/**
 * Reads a dataset file for import. Accepted shapes (see README "Dataset import format"):
 *
 *   {"cases": [ {...}, {...} ]}      an object with a cases array
 *   [ {...}, {...} ]                 a bare array
 *   {...}\n{...}\n                   JSON Lines, one case per line
 *
 * Field-level validation happens on the server (dry run), which reports every problem at once.
 */

export type ImportParse =
  | { ok: true; cases: Array<Record<string, unknown>> }
  | { ok: false; error: string };

function asCases(value: unknown): ImportParse {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { cases?: unknown }).cases)
      ? (value as { cases: unknown[] }).cases
      : null;
  if (list === null) {
    return { ok: false, error: 'Expected an array of cases or an object with a "cases" array' };
  }
  if (list.length === 0) return { ok: false, error: "The file contains no cases" };
  const invalid = list.findIndex((item) => !item || typeof item !== "object" || Array.isArray(item));
  if (invalid !== -1) return { ok: false, error: `Case ${invalid} is not a JSON object` };
  return { ok: true, cases: list as Array<Record<string, unknown>> };
}

export function parseDatasetText(text: string): ImportParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste JSON or choose a file to import" };
  try {
    return asCases(JSON.parse(trimmed));
  } catch (error) {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 1) {
      const cases: unknown[] = [];
      for (const [index, line] of lines.entries()) {
        try {
          cases.push(JSON.parse(line));
        } catch {
          return { ok: false, error: `Line ${index + 1} is not valid JSON` };
        }
      }
      return asCases(cases);
    }
    return { ok: false, error: `Invalid JSON: ${(error as Error).message}` };
  }
}
