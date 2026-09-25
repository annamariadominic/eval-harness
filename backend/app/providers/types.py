"""Provider-neutral request/response types shared by every adapter."""

from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

Role = Literal["system", "user", "assistant"]


class Message(BaseModel):
    model_config = ConfigDict(frozen=True)

    role: Role
    content: str


class ModelConfig(BaseModel):
    """Everything a provider needs to issue one request, besides the messages."""

    model_config = ConfigDict(frozen=True)

    model: str
    temperature: float | None = None
    max_tokens: int = 1024
    # When set, adapters request schema-constrained JSON output where the provider supports it.
    response_schema: dict[str, Any] | None = None
    schema_name: str = "response"
    # Provider-specific extras passed through verbatim (e.g. ``top_p``, ``reasoning_effort``).
    settings: dict[str, Any] = Field(default_factory=dict)


class GenerationResult(BaseModel):
    output: str
    latency_ms: float
    input_tokens: int | None
    output_tokens: int | None
    model: str
    provider: str
    finish_reason: str | None = None

    @property
    def total_tokens(self) -> int | None:
        if self.input_tokens is None and self.output_tokens is None:
            return None
        return (self.input_tokens or 0) + (self.output_tokens or 0)


ErrorKind = Literal[
    "not_configured",
    "auth",
    "bad_request",
    "rate_limited",
    "timeout",
    "connection",
    "server_error",
    "refusal",
    "invalid_response",
    "unknown",
]

RETRYABLE_KINDS: frozenset[str] = frozenset(
    {"rate_limited", "timeout", "connection", "server_error"}
)


class ProviderError(Exception):
    """A classified provider failure. ``retryable`` drives the runner's retry policy."""

    def __init__(
        self,
        message: str,
        *,
        kind: ErrorKind,
        status_code: int | None = None,
        retry_after_s: float | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.kind: ErrorKind = kind
        self.status_code = status_code
        self.retry_after_s = retry_after_s

    @property
    def retryable(self) -> bool:
        return self.kind in RETRYABLE_KINDS


class ModelProvider(Protocol):
    """The only surface the runner and judges use to talk to a model."""

    name: str

    async def generate(self, messages: list[Message], config: ModelConfig) -> GenerationResult: ...
