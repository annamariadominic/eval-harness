/** Port of `app/providers/types.py`: provider-neutral request and response types. */

export type Role = "system" | "user" | "assistant";

export type Message = { role: Role; content: string };

export type ModelConfig = {
  model: string;
  temperature?: number | null;
  max_tokens?: number;
  response_schema?: Record<string, unknown> | null;
  schema_name?: string;
  settings?: Record<string, unknown>;
};

export type GenerationResult = {
  output: string;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  model: string;
  provider: string;
  finish_reason: string | null;
};

export type ErrorKind =
  | "not_configured"
  | "auth"
  | "bad_request"
  | "rate_limited"
  | "timeout"
  | "connection"
  | "server_error"
  | "refusal"
  | "invalid_response"
  | "unknown";

const RETRYABLE_KINDS = new Set<ErrorKind>([
  "rate_limited",
  "timeout",
  "connection",
  "server_error",
]);

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly statusCode: number | null = null,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export interface ModelProvider {
  readonly name: string;
  generate(messages: Message[], config: ModelConfig): Promise<GenerationResult>;
}

export type Sleep = (seconds: number) => Promise<void>;

export const realSleep: Sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
