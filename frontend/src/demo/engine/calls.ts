/**
 * Ports of `app/runner/retry.py` and `app/runner/model_calls.py`: the single path from the
 * runner (and judges) to a model — provider lookup, retries with backoff, and cost estimation.
 */

import type { ModelCall } from "./evaluators/base";
import type { PricingTable } from "./pricing";
import {
  ProviderError,
  realSleep,
  type Message,
  type ModelConfig,
  type ModelProvider,
  type Sleep,
} from "./providers";

export type RetryPolicy = { max_attempts: number; base_delay_s: number; max_delay_s: number };

export function retryPolicy(maxAttempts = 3): RetryPolicy {
  return { max_attempts: maxAttempts, base_delay_s: 0.5, max_delay_s: 8.0 };
}

/** Delay before the retry that follows `attempt` (1-based), with full jitter. */
export function delayFor(policy: RetryPolicy, attempt: number, random = Math.random): number {
  const ceiling = Math.min(policy.max_delay_s, policy.base_delay_s * 2 ** (attempt - 1));
  return random() * ceiling;
}

/** Raised when a call fails permanently or exhausts its attempts. */
export class CallFailedError extends Error {
  constructor(
    readonly error: ProviderError,
    readonly attempts: number,
  ) {
    super(error.message);
    this.name = "CallFailedError";
  }
}

export async function callWithRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  sleep: Sleep = realSleep,
): Promise<[T, number]> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return [await operation(), attempt];
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (!error.retryable || attempt >= policy.max_attempts) {
        throw new CallFailedError(error, attempt);
      }
      let delay = delayFor(policy, attempt);
      if (error.retryAfterS !== null) {
        delay = Math.max(delay, Math.min(error.retryAfterS, policy.max_delay_s * 4));
      }
      await sleep(delay);
    }
  }
}

/** Looks providers up by name; unknown or unconfigured ones fail like the backend's registry. */
export class ProviderRegistry {
  constructor(
    private readonly providers: Record<string, ModelProvider>,
    private readonly envVars: Record<string, string> = {},
  ) {}

  get(name: string): ModelProvider {
    const provider = this.providers[name];
    if (provider) return provider;
    const envVar = this.envVars[name];
    const message = envVar
      ? `Provider '${name}' is not configured: set ${envVar}`
      : `Unknown provider '${name}'`;
    throw new ProviderError(message, "not_configured");
  }
}

export class PricedModelCaller {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly pricing: PricingTable,
    private readonly policy: RetryPolicy,
    private readonly sleep: Sleep = realSleep,
  ) {}

  readonly call = async (
    provider: string,
    messages: Message[],
    config: ModelConfig,
  ): Promise<ModelCall> => {
    let adapter: ModelProvider;
    try {
      adapter = this.registry.get(provider);
    } catch (error) {
      if (error instanceof ProviderError) throw new CallFailedError(error, 0);
      throw error;
    }
    const [result, attempts] = await callWithRetry(
      () => adapter.generate(messages, config),
      this.policy,
      this.sleep,
    );
    const cost = this.pricing.estimate(
      provider,
      config.model,
      result.input_tokens,
      result.output_tokens,
    );
    return { result, cost_usd: cost, attempts };
  };
}
