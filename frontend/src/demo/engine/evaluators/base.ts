/** Port of `app/evaluators/base.py`: the evaluator contract. */

import type { GenerationResult, Message, ModelConfig } from "../providers";

export type EvaluationSample = {
  input: unknown;
  expected: unknown;
  output: string;
};

export type ModelUsage = {
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
};

/** `score` is normalised to 0-1 when present; binary checks report 1.0/0.0 alongside `passed`. */
export type EvaluatorOutcome = {
  score: number | null;
  passed: boolean | null;
  reason: string;
  details: Record<string, unknown>;
  usage: ModelUsage | null;
};

export function binary(
  passed: boolean,
  reason: string,
  details: Record<string, unknown> = {},
): EvaluatorOutcome {
  return { score: passed ? 1.0 : 0.0, passed, reason, details, usage: null };
}

/** The evaluator could not produce a verdict (as opposed to producing a failing one). */
export class EvaluatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorError";
  }
}

export type ModelCall = { result: GenerationResult; cost_usd: number | null; attempts: number };

export type ModelCaller = (
  provider: string,
  messages: Message[],
  config: ModelConfig,
) => Promise<ModelCall>;

export interface Evaluator {
  evaluate(sample: EvaluationSample): Promise<EvaluatorOutcome>;
}
