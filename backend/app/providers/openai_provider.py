"""OpenAI adapter (Chat Completions API)."""

import time
from typing import Any

import openai
from openai import AsyncOpenAI

from app.providers.types import (
    GenerationResult,
    Message,
    ModelConfig,
    ProviderError,
    classify_http_status,
)


class OpenAIProvider:
    name = "openai"

    def __init__(
        self, *, api_key: str, timeout_s: float = 60.0, client: AsyncOpenAI | None = None
    ) -> None:
        # SDK retries are disabled: the runner owns retry policy so attempts are counted and
        # persisted, and a request is never silently retried twice over.
        self._client = client or AsyncOpenAI(api_key=api_key, max_retries=0, timeout=timeout_s)

    async def generate(self, messages: list[Message], config: ModelConfig) -> GenerationResult:
        request: dict[str, Any] = {
            "model": config.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_completion_tokens": config.max_tokens,
        }
        if config.temperature is not None:
            request["temperature"] = config.temperature
        if config.response_schema is not None:
            request["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": config.schema_name,
                    "schema": config.response_schema,
                    "strict": True,
                },
            }

        started = time.perf_counter()
        try:
            response = await self._client.chat.completions.create(
                **request, extra_body=config.settings or None
            )
        except openai.APITimeoutError as exc:
            raise ProviderError(f"OpenAI request timed out: {exc}", kind="timeout") from exc
        except openai.APIConnectionError as exc:
            raise ProviderError(f"Could not reach OpenAI: {exc}", kind="connection") from exc
        except openai.APIStatusError as exc:
            raise ProviderError(
                f"OpenAI returned {exc.status_code}: {exc.message}",
                kind=classify_http_status(exc.status_code),
                status_code=exc.status_code,
                retry_after_s=_retry_after(exc.response.headers.get("retry-after")),
            ) from exc
        latency_ms = (time.perf_counter() - started) * 1000

        if not response.choices:
            raise ProviderError("OpenAI returned no choices", kind="invalid_response")
        choice = response.choices[0]
        if getattr(choice.message, "refusal", None):
            raise ProviderError(f"Model refused: {choice.message.refusal}", kind="refusal")
        usage = response.usage
        return GenerationResult(
            output=choice.message.content or "",
            latency_ms=round(latency_ms, 1),
            input_tokens=usage.prompt_tokens if usage else None,
            output_tokens=usage.completion_tokens if usage else None,
            model=response.model or config.model,
            provider=self.name,
            finish_reason=choice.finish_reason,
        )


def _retry_after(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None
