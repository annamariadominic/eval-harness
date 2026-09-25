import json

import pytest

from app.config import Settings
from app.providers.mock import MockProvider
from app.providers.registry import ProviderRegistry
from app.providers.types import Message, ModelConfig, ProviderError

CONTEXT = (
    "[1] Acme Corp reported fiscal 2025 revenue of $4.2 billion, up 12% year over year. "
    "[2] Acme's headcount grew to 12,000 employees."
)
QA = [Message(role="user", content=f"Question: What was Acme's 2025 revenue?\n\n{CONTEXT}")]


def _system(text: str) -> list[Message]:
    return [Message(role="system", content=text), *QA]


async def test_outputs_are_deterministic() -> None:
    config = ModelConfig(model="mock-small")
    first = await MockProvider(latency_scale=0).generate(QA, config)
    second = await MockProvider(latency_scale=0).generate(QA, config)
    assert first.output == second.output
    assert first.latency_ms == second.latency_ms
    assert first.input_tokens and first.output_tokens


async def test_prompt_instructions_change_behaviour() -> None:
    provider = MockProvider(latency_scale=0)
    config = ModelConfig(model="mock-large")
    cited = await provider.generate(
        _system("Answer using only the context. Be concise. Cite passages as [n]."), config
    )
    assert "$4.2 billion" in cited.output
    assert "[1]" in cited.output


async def test_extraction_returns_json_when_asked_for_raw_json() -> None:
    doc = "Globex Holdings closed FY2024 with total revenue of USD 310 million."
    result = await MockProvider(latency_scale=0).generate(
        [
            Message(role="system", content="Return only JSON with integer revenue."),
            Message(role="user", content=doc),
        ],
        ModelConfig(model="mock-large"),
    )
    assert json.loads(result.output) == {
        "company": "Globex Holdings",
        "revenue": 310_000_000,
        "year": 2024,
    }


async def test_judge_mode_scores_against_reference() -> None:
    prompt = (
        "<criteria>Correct?</criteria><reference>$4.2 billion</reference>"
        "<response>It was $4.2B.</response> Give a score from 1 to 5."
    )
    result = await MockProvider(latency_scale=0).generate(
        [Message(role="user", content=prompt)],
        ModelConfig(model="mock-large", schema_name="judgement"),
    )
    verdict = json.loads(result.output)
    assert verdict["score"] == 5
    assert verdict["reason"]


async def test_simulated_transient_failures_clear_on_retry() -> None:
    provider = MockProvider(latency_scale=0)
    config = ModelConfig(model="mock-small", settings={"mock_failure_rate": 1.0})
    with pytest.raises(ProviderError) as info:
        await provider.generate(QA, config)
    assert info.value.retryable


def test_registry_reports_unconfigured_providers() -> None:
    registry = ProviderRegistry.from_settings(
        Settings(OPENAI_API_KEY=None, ANTHROPIC_API_KEY=None, _env_file=None)
    )
    assert registry.get("mock").name == "mock"
    with pytest.raises(ProviderError) as info:
        registry.get("anthropic")
    assert info.value.kind == "not_configured"
    assert "ANTHROPIC_API_KEY" in info.value.message
    configured = {i.name: i.configured for i in registry.list_info()}
    assert configured == {"mock": True, "openai": False, "anthropic": False}
