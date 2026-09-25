"""Anthropic adapter (Messages API)."""

import time
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from app.providers.types import (
    GenerationResult,
    Message,
    ModelConfig,
    ProviderError,
    classify_http_status,
)


class AnthropicProvider:
    name = "anthropic"

    def __init__(
        self, *, api_key: str, timeout_s: float = 60.0, client: AsyncAnthropic | None = None
    ) -> None:
        # SDK retries are disabled; see OpenAIProvider for the rationale.
        self._client = client or AsyncAnthropic(api_key=api_key, max_retries=0, timeout=timeout_s)

    async def generate(self, messages: list[Message], config: ModelConfig) -> GenerationResult:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        request: dict[str, Any] = {
            "model": config.model,
            "max_tokens": config.max_tokens,
            "messages": [
                {"role": m.role, "content": m.content} for m in messages if m.role != "system"
            ],
        }
        if system:
            request["system"] = system
        if config.response_schema is not None:
            request["output_config"] = {
                "format": {"type": "json_schema", "schema": config.response_schema}
            }
        # Sampling parameters are not part of the SDK 1.x signature and newer models reject them,
        # so temperature is only forwarded when a variant explicitly sets it.
        extra_body: dict[str, Any] = dict(config.settings)
        if config.temperature is not None:
            extra_body["temperature"] = config.temperature

        started = time.perf_counter()
        try:
            response = await self._client.messages.create(**request, extra_body=extra_body or None)
        except anthropic.APITimeoutError as exc:
            raise ProviderError(f"Anthropic request timed out: {exc}", kind="timeout") from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError(f"Could not reach Anthropic: {exc}", kind="connection") from exc
        except anthropic.APIStatusError as exc:
            retry_after = exc.response.headers.get("retry-after")
            raise ProviderError(
                f"Anthropic returned {exc.status_code}: {exc.message}",
                kind=classify_http_status(exc.status_code),
                status_code=exc.status_code,
                retry_after_s=float(retry_after) if retry_after and retry_after.isdigit() else None,
            ) from exc
        latency_ms = (time.perf_counter() - started) * 1000

        if response.stop_reason == "refusal":
            raise ProviderError("Model declined to answer (stop_reason=refusal)", kind="refusal")
        text = "".join(block.text for block in response.content if block.type == "text")
        return GenerationResult(
            output=text,
            latency_ms=round(latency_ms, 1),
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            model=response.model,
            provider=self.name,
            finish_reason=response.stop_reason,
        )
