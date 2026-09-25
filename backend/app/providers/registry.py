"""Provider registry: the single place that knows which adapters exist and are configured."""

from dataclasses import dataclass, field

from app.config import Settings
from app.providers.anthropic_provider import AnthropicProvider
from app.providers.mock import MockProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.types import ModelProvider, ProviderError


@dataclass(frozen=True)
class ProviderInfo:
    name: str
    label: str
    description: str
    configured: bool
    suggested_models: list[str] = field(default_factory=list)
    env_var: str | None = None


class ProviderRegistry:
    def __init__(self, providers: dict[str, ModelProvider], info: list[ProviderInfo]) -> None:
        self._providers = providers
        self._info = info

    @classmethod
    def from_settings(cls, settings: Settings) -> "ProviderRegistry":
        providers: dict[str, ModelProvider] = {
            "mock": MockProvider(latency_scale=settings.mock_latency_scale)
        }
        if settings.openai_api_key:
            providers["openai"] = OpenAIProvider(
                api_key=settings.openai_api_key, timeout_s=settings.request_timeout_s
            )
        if settings.anthropic_api_key:
            providers["anthropic"] = AnthropicProvider(
                api_key=settings.anthropic_api_key, timeout_s=settings.request_timeout_s
            )
        info = [
            ProviderInfo(
                name="mock",
                label="Mock",
                description="Deterministic offline provider. No API key, no cost.",
                configured=True,
                suggested_models=["mock-small", "mock-large"],
            ),
            ProviderInfo(
                name="openai",
                label="OpenAI",
                description="Chat Completions API.",
                configured="openai" in providers,
                suggested_models=["gpt-5", "gpt-5-mini", "gpt-4.1-mini"],
                env_var="OPENAI_API_KEY",
            ),
            ProviderInfo(
                name="anthropic",
                label="Anthropic",
                description="Claude Messages API.",
                configured="anthropic" in providers,
                suggested_models=["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
                env_var="ANTHROPIC_API_KEY",
            ),
        ]
        return cls(providers, info)

    def get(self, name: str) -> ModelProvider:
        provider = self._providers.get(name)
        if provider is not None:
            return provider
        known = {i.name: i for i in self._info}
        if name in known and known[name].env_var:
            message = f"Provider '{name}' is not configured: set {known[name].env_var}"
        else:
            message = f"Unknown provider '{name}'"
        raise ProviderError(message, kind="not_configured")

    def known_names(self) -> set[str]:
        return {i.name for i in self._info}

    def list_info(self) -> list[ProviderInfo]:
        return list(self._info)
