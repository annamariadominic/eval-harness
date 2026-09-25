"""The evaluator contract.

An evaluator receives an :class:`EvaluationSample` and returns an :class:`EvaluatorOutcome`.
Deterministic evaluators are pure; model-based evaluators receive a :class:`ModelCaller`
injected by the runner, so they never deal with provider lookup, retries, or pricing.
"""

from dataclasses import dataclass, field
from typing import Any, Protocol

from app.providers.types import GenerationResult, Message, ModelConfig


@dataclass(frozen=True)
class EvaluationSample:
    input: Any
    expected: Any
    output: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ModelUsage:
    latency_ms: float | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None


@dataclass(frozen=True)
class EvaluatorOutcome:
    """Result of one evaluation.

    ``score`` is normalised to 0-1 when present. Binary checks report 1.0/0.0 alongside
    ``passed`` so they aggregate naturally, while the API still exposes them as pass/fail.
    """

    score: float | None
    passed: bool | None
    reason: str
    details: dict[str, Any] = field(default_factory=dict)
    usage: ModelUsage | None = None

    @classmethod
    def binary(cls, passed: bool, reason: str, **details: Any) -> "EvaluatorOutcome":
        return cls(score=1.0 if passed else 0.0, passed=passed, reason=reason, details=details)


class EvaluatorError(Exception):
    """The evaluator could not produce a verdict (as opposed to producing a failing one)."""


@dataclass(frozen=True)
class ModelCall:
    result: GenerationResult
    cost_usd: float | None
    attempts: int


class ModelCaller(Protocol):
    async def __call__(
        self, provider: str, messages: list[Message], config: ModelConfig
    ) -> ModelCall: ...


class Evaluator(Protocol):
    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome: ...
