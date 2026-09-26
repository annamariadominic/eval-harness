/** Everything a service needs, bundled so handlers stay as thin as the FastAPI routes. */

import openapi from "@/lib/api/openapi.json";

import type { EvaluatorRegistry, PricingTable } from "../engine";
import { validateObject, type ObjectValidationOptions, type Schema } from "../engine/validation";
import type { Database } from "./db";
import { RequestValidationError } from "./errors";
import type { RunManager } from "./runner";

export type ProviderInfo = {
  name: string;
  label: string;
  description: string;
  configured: boolean;
  suggested_models: string[];
  env_var: string | null;
};

export type Settings = { default_concurrency: number; max_concurrency: number };

export type Context = {
  db: Database;
  registry: EvaluatorRegistry;
  pricing: PricingTable;
  providers: ProviderInfo[];
  manager: RunManager;
  settings: Settings;
};

export const DEFAULT_SETTINGS: Settings = { default_concurrency: 4, max_concurrency: 32 };

const schemas = openapi.components.schemas as unknown as Record<string, Schema>;

function resolveRef(ref: string): Schema {
  return schemas[ref.replace("#/components/schemas/", "")];
}

/**
 * Validate a request body against the backend's Pydantic model (via the OpenAPI document),
 * raising the same 422 `validation_error` FastAPI would.
 */
export function parseBody(
  model: string,
  body: unknown,
  options: Omit<ObjectValidationOptions, "resolveRef" | "locPrefix"> = {},
): { value: Record<string, unknown>; set: Set<string> } {
  const { value, set, issues } = validateObject(schemas[model], body, {
    ...options,
    resolveRef,
    locPrefix: ["body"],
  });
  if (issues.length) throw new RequestValidationError(issues);
  return { value, set };
}

/** Provider names the backend knows about, configured or not (for variant validation). */
export function knownProviders(ctx: Context): string[] {
  return ctx.providers.map((p) => p.name).sort();
}
