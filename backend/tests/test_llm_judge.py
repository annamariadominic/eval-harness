import json

import pytest
from pydantic import ValidationError

from app.evaluators.base import EvaluationSample, EvaluatorError, ModelCall
from app.evaluators.judge import LLMJudgeConfig, LLMJudgeEvaluator, build_judge_prompt
from app.evaluators.registry import (
    EVALUATOR_TYPES,
    InvalidEvaluatorConfig,
    build_evaluator,
    normalize_config,
)
from app.providers.mock import MockProvider
from app.providers.types import GenerationResult, Message, ModelConfig

SAMPLE = EvaluationSample(
    input={"question": "What was Acme's 2025 revenue?"},
    expected={"answer": "$4.2 billion"},
    output="Acme reported revenue of $4.2 billion in 2025.",
)


class FixedCaller:
    """A ModelCaller that returns a canned judge response and records what it was sent."""

    def __init__(self, output: str) -> None:
        self.output = output
        self.calls: list[tuple[str, list[Message], ModelConfig]] = []

    async def __call__(
        self, provider: str, messages: list[Message], config: ModelConfig
    ) -> ModelCall:
        self.calls.append((provider, messages, config))
        return ModelCall(
            result=GenerationResult(
                output=self.output,
                latency_ms=12.0,
                input_tokens=100,
                output_tokens=20,
                model=config.model,
                provider=provider,
            ),
            cost_usd=0.001,
            attempts=1,
        )


def config(**overrides: object) -> LLMJudgeConfig:
    base: dict[str, object] = {
        "provider": "mock",
        "model": "mock-large",
        "criteria": "Is the answer factually correct?",
        "score_min": 1,
        "score_max": 5,
        "pass_threshold": 0.75,
    }
    return LLMJudgeConfig.model_validate(base | overrides)


async def test_normalises_score_and_applies_threshold() -> None:
    caller = FixedCaller(json.dumps({"reason": "Correct figure, no fiscal qualifier.", "score": 4}))
    outcome = await LLMJudgeEvaluator(config(), caller).evaluate(SAMPLE)
    assert outcome.score == pytest.approx(0.75)
    assert outcome.passed is True
    assert outcome.reason == "Correct figure, no fiscal qualifier."
    assert outcome.details["raw_score"] == 4
    assert outcome.usage is not None and outcome.usage.cost_usd == 0.001

    provider, _, model_config = caller.calls[0]
    assert provider == "mock"
    assert model_config.schema_name == "judgement"
    assert model_config.response_schema is not None


async def test_below_threshold_fails() -> None:
    caller = FixedCaller(json.dumps({"reason": "Wrong year.", "score": 3}))
    outcome = await LLMJudgeEvaluator(config(), caller).evaluate(SAMPLE)
    assert outcome.score == pytest.approx(0.5)
    assert outcome.passed is False


@pytest.mark.parametrize(
    "output",
    ["not json", json.dumps({"score": 4}), json.dumps({"reason": "", "score": 4})],
)
async def test_malformed_verdicts_are_evaluator_errors(output: str) -> None:
    with pytest.raises(EvaluatorError):
        await LLMJudgeEvaluator(config(), FixedCaller(output)).evaluate(SAMPLE)


async def test_out_of_range_score_is_an_error() -> None:
    caller = FixedCaller(json.dumps({"reason": "Great", "score": 9}))
    with pytest.raises(EvaluatorError, match="outside the range"):
        await LLMJudgeEvaluator(config(), caller).evaluate(SAMPLE)


def test_prompt_sections_follow_config() -> None:
    with_all = build_judge_prompt(config(), SAMPLE)
    assert "<input>" in with_all and "<reference>" in with_all and "<response>" in with_all
    assert "score from 1 to 5" in with_all
    bare = build_judge_prompt(config(include_input=False, include_expected=False), SAMPLE)
    assert "<input>" not in bare and "<reference>" not in bare


def test_invalid_range_rejected() -> None:
    with pytest.raises(ValidationError):
        config(score_min=5, score_max=1)


async def test_end_to_end_with_mock_provider() -> None:
    provider = MockProvider(latency_scale=0)

    async def call(provider_name: str, messages: list[Message], cfg: ModelConfig) -> ModelCall:
        return ModelCall(result=await provider.generate(messages, cfg), cost_usd=None, attempts=1)

    outcome = await LLMJudgeEvaluator(config(), call).evaluate(SAMPLE)
    assert outcome.passed is True
    assert outcome.reason


class TestRegistry:
    def test_every_type_has_a_buildable_default(self) -> None:
        assert set(EVALUATOR_TYPES) >= {
            "exact_match",
            "contains",
            "regex",
            "json_valid",
            "json_schema",
            "required_fields",
            "field_match",
            "llm_judge",
        }

    def test_normalize_fills_defaults(self) -> None:
        assert normalize_config("json_valid", {}) == {"allow_code_fence": False}

    def test_unknown_type_and_bad_config(self) -> None:
        with pytest.raises(InvalidEvaluatorConfig, match="Unknown evaluator type"):
            normalize_config("vibes", {})
        with pytest.raises(InvalidEvaluatorConfig) as info:
            normalize_config("regex", {"pattern": "(", "extra": 1})
        assert info.value.errors

    def test_judge_requires_caller(self) -> None:
        with pytest.raises(ValueError):
            build_evaluator("llm_judge", config().model_dump())
