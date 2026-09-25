"""LLM-as-a-judge evaluator with a user-defined rubric.

The judge is asked for ``{"reason": str, "score": number}`` using the provider's structured
output mode, and the response is validated again locally (providers without strict schema
support can still return malformed JSON). Pass/fail is decided here from the normalised score
and the configured threshold, not by the model, so the threshold can change without re-running.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from app.evaluators.base import (
    EvaluationSample,
    EvaluatorError,
    EvaluatorOutcome,
    ModelCaller,
    ModelUsage,
)
from app.evaluators.output import JsonParseError, parse_json_output, to_text
from app.providers.types import Message, ModelConfig

JUDGE_SCHEMA_NAME = "judgement"
JUDGE_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "reason": {
            "type": "string",
            "description": "Concise justification for the score, citing specifics.",
        },
        "score": {"type": "number"},
    },
    "required": ["reason", "score"],
    "additionalProperties": False,
}

JUDGE_SYSTEM_PROMPT = (
    "You are a rigorous, impartial evaluator of AI-generated responses. Judge only against the "
    "stated criteria. Explain your reasoning briefly and concretely before settling on a score. "
    'Respond with a JSON object of the form {"reason": string, "score": number}.'
)


class LLMJudgeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str
    model: str
    criteria: str = Field(min_length=1, description="Rubric the judge applies.")
    score_min: float = 0.0
    score_max: float = 1.0
    pass_threshold: float = Field(
        default=0.7, ge=0, le=1, description="Minimum normalised score (0-1) to pass."
    )
    include_input: bool = True
    include_expected: bool = True
    temperature: float | None = None
    max_tokens: int = Field(default=1024, ge=64, le=16_000)

    @model_validator(mode="after")
    def _range_is_valid(self) -> "LLMJudgeConfig":
        if self.score_max <= self.score_min:
            raise ValueError("score_max must be greater than score_min")
        return self


class JudgeVerdict(BaseModel):
    reason: str = Field(min_length=1)
    score: float


def build_judge_prompt(config: LLMJudgeConfig, sample: EvaluationSample) -> str:
    sections = [
        "Evaluate the response below against the criteria.",
        f"<criteria>\n{config.criteria.strip()}\n</criteria>",
    ]
    if config.include_input:
        sections.append(f"<input>\n{to_text(sample.input)}\n</input>")
    if config.include_expected and sample.expected is not None:
        sections.append(f"<reference>\n{to_text(sample.expected)}\n</reference>")
    sections.append(f"<response>\n{sample.output}\n</response>")
    sections.append(
        f"Give a score from {_fmt(config.score_min)} to {_fmt(config.score_max)}, where "
        f"{_fmt(config.score_min)} means the response completely fails the criteria and "
        f"{_fmt(config.score_max)} means it fully satisfies them."
    )
    return "\n\n".join(sections)


class LLMJudgeEvaluator:
    def __init__(self, config: LLMJudgeConfig, call_model: ModelCaller) -> None:
        self.config = config
        self._call_model = call_model

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        messages = [
            Message(role="system", content=JUDGE_SYSTEM_PROMPT),
            Message(role="user", content=build_judge_prompt(self.config, sample)),
        ]
        model_config = ModelConfig(
            model=self.config.model,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            response_schema=JUDGE_RESPONSE_SCHEMA,
            schema_name=JUDGE_SCHEMA_NAME,
        )
        call = await self._call_model(self.config.provider, messages, model_config)
        verdict = parse_verdict(call.result.output)

        low, high = self.config.score_min, self.config.score_max
        if not low <= verdict.score <= high:
            raise EvaluatorError(
                f"Judge returned score {verdict.score}, outside the range {_fmt(low)}-{_fmt(high)}"
            )
        normalised = (verdict.score - low) / (high - low)
        return EvaluatorOutcome(
            score=normalised,
            passed=normalised >= self.config.pass_threshold,
            reason=verdict.reason,
            details={
                "raw_score": verdict.score,
                "score_range": [low, high],
                "judge_model": call.result.model,
                "attempts": call.attempts,
            },
            usage=ModelUsage(
                latency_ms=call.result.latency_ms,
                input_tokens=call.result.input_tokens,
                output_tokens=call.result.output_tokens,
                cost_usd=call.cost_usd,
            ),
        )


def parse_verdict(text: str) -> JudgeVerdict:
    try:
        data = parse_json_output(text, allow_code_fence=True)
        return JudgeVerdict.model_validate(data)
    except (JsonParseError, ValidationError) as exc:
        preview = text if len(text) <= 200 else text[:200] + "…"
        raise EvaluatorError(
            f"Judge response did not match the expected schema: {preview}"
        ) from exc


def _fmt(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else str(value)


__all__ = ["LLMJudgeConfig", "LLMJudgeEvaluator", "build_judge_prompt", "parse_verdict"]
