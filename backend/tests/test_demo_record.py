import json
from pathlib import Path

import pytest

from app.config import BACKEND_ROOT, Settings
from app.demo.record import RecordingError, load_spec, missing_keys, record, required_providers
from app.pricing import PricingTable
from app.providers.mock import MockProvider
from app.providers.registry import ProviderRegistry
from app.providers.types import GenerationResult, Message, ModelConfig

PRICING = BACKEND_ROOT / "pricing.json"


class FakeRealProvider:
    """Stands in for OpenAI/Anthropic: answers prompts, and returns verdicts to judge requests."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.calls = 0

    async def generate(self, messages: list[Message], config: ModelConfig) -> GenerationResult:
        self.calls += 1
        if config.schema_name == "judgement":
            output = json.dumps({"reason": "Looks right.", "score": 1})
        else:
            output = '{"company": "Acme Corp", "revenue": 1, "year": 2025} [1]'
        return GenerationResult(
            output=output,
            latency_ms=12.0,
            input_tokens=100,
            output_tokens=20,
            model=config.model,
            provider=self.name,
        )


def _settings(**keys: str | None) -> Settings:
    return Settings(
        OPENAI_API_KEY=keys.get("openai"),
        ANTHROPIC_API_KEY=keys.get("anthropic"),
        EVAL_HARNESS_MOCK_LATENCY_SCALE=0,
        _env_file=None,
    )


def _registry() -> tuple[ProviderRegistry, dict[str, FakeRealProvider]]:
    fakes = {"openai": FakeRealProvider("openai"), "anthropic": FakeRealProvider("anthropic")}
    registry = ProviderRegistry(
        {"mock": MockProvider(latency_scale=0), **fakes},
        ProviderRegistry.from_settings(_settings()).list_info(),
    )
    return registry, fakes


def test_spec_needs_both_real_providers_and_reports_missing_keys() -> None:
    spec = load_spec()
    seeded = {"Research QA": {"Claude Sonnet 5 · prompt v2": "anthropic"}}
    needed = required_providers(spec, seeded)
    assert needed == {"openai", "anthropic"}
    assert missing_keys(needed, _settings()) == ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
    assert missing_keys(needed, _settings(openai="a", anthropic="b")) == []


async def test_recording_refuses_to_run_without_keys(tmp_path: Path) -> None:
    registry, fakes = _registry()
    with pytest.raises(RecordingError, match="OPENAI_API_KEY"):
        await record(
            spec=load_spec(),
            db_path=tmp_path / "rec.db",
            settings=_settings(anthropic="b"),
            registry=registry,
            pricing=PricingTable.from_file(PRICING),
            pricing_file=PRICING,
            confirm=lambda _summary: True,
        )
    assert all(f.calls == 0 for f in fakes.values())


async def test_declining_the_estimate_spends_nothing(tmp_path: Path) -> None:
    registry, fakes = _registry()
    summaries: list[str] = []

    def decline(summary: str) -> bool:
        summaries.append(summary)
        return False

    result = await record(
        spec=load_spec(),
        db_path=tmp_path / "rec.db",
        settings=_settings(openai="a", anthropic="b"),
        registry=registry,
        pricing=PricingTable.from_file(PRICING),
        pricing_file=PRICING,
        confirm=decline,
    )
    assert result is None
    assert all(f.calls == 0 for f in fakes.values())
    assert "78 generations and 96 judge calls" in summaries[0]
    assert "estimated cost: about $" in summaries[0]


async def test_confirmed_recording_executes_every_planned_run(tmp_path: Path) -> None:
    registry, fakes = _registry()
    run_ids = await record(
        spec=load_spec(),
        db_path=tmp_path / "rec.db",
        settings=_settings(openai="a", anthropic="b"),
        registry=registry,
        pricing=PricingTable.from_file(PRICING),
        pricing_file=PRICING,
        confirm=lambda _summary: True,
    )
    assert run_ids is not None and len(run_ids) == 2
    # 12 QA cases x 4 variants + 10 extraction cases x 3 variants, plus 2 judges per QA item.
    assert fakes["openai"].calls + fakes["anthropic"].calls == 12 * 4 + 10 * 3 + 12 * 4 * 2
