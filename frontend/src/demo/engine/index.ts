/**
 * The demo engine: a TypeScript port of the backend's pure building blocks (templates, pricing,
 * the mock provider, evaluators, the retrying model caller, and the analysis functions), used by
 * the in-browser demo backend.
 *
 * Python remains the source of truth. Every module is checked against golden fixtures exported
 * from the real backend (`backend/app/demo/export.py`); outputs, scores, reasons, and metrics
 * match exactly. The known, documented divergences are all consequences of JavaScript numbers:
 *
 * - An integral float in user data (`3.0`) prints as `3`, because a JavaScript number cannot
 *   remember the `.0`. Values the engine itself computes as floats print like Python.
 * - Integers beyond 2^53 lose precision.
 * - Error messages for invalid regular expressions and invalid JSON Schemas come from the
 *   JavaScript engines, so their wording differs (the configs are still rejected).
 */

export * from "./analysis";
export * from "./calls";
export * from "./evaluators/base";
export { EvaluatorRegistry, InvalidEvaluatorConfig } from "./evaluators/registry";
export type { ConfigErrorDetail, EvaluatorTypeInfo } from "./evaluators/registry";
export { MockProvider } from "./mock-provider";
export { PricingTable } from "./pricing";
export type { ModelPrice } from "./pricing";
export * from "./providers";
export { renderTemplate, TemplateError, templateVariables } from "./templates";
