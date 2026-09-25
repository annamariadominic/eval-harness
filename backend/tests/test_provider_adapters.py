"""Adapter tests against in-process HTTP transports — no network, no API keys."""

import json
from typing import Any

import httpx
import httpx2
import pytest
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from app.providers.anthropic_provider import AnthropicProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.types import Message, ModelConfig, ProviderError

MESSAGES = [
    Message(role="system", content="Be terse."),
    Message(role="user", content="Say hi"),
]


def _openai(handler: Any) -> OpenAIProvider:
    client = AsyncOpenAI(
        api_key="test",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return OpenAIProvider(api_key="test", client=client)


def _anthropic(handler: Any) -> AnthropicProvider:
    client = AsyncAnthropic(
        api_key="test",
        max_retries=0,
        http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    return AnthropicProvider(api_key="test", client=client)


async def test_openai_request_shape_and_usage() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 0,
                "model": "gpt-test-2026",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "hi"},
                    }
                ],
                "usage": {"prompt_tokens": 11, "completion_tokens": 2, "total_tokens": 13},
            },
        )

    schema = {"type": "object", "properties": {}, "additionalProperties": False}
    result = await _openai(handler).generate(
        MESSAGES,
        ModelConfig(model="gpt-test", temperature=0.2, response_schema=schema, schema_name="x"),
    )
    assert seen["messages"][0] == {"role": "system", "content": "Be terse."}
    assert seen["temperature"] == 0.2
    assert seen["max_completion_tokens"] == 1024
    assert seen["response_format"]["json_schema"]["strict"] is True
    assert result.output == "hi"
    assert (result.input_tokens, result.output_tokens) == (11, 2)
    assert result.provider == "openai"


async def test_openai_omits_temperature_when_unset() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(429, json={"error": {"message": "slow down"}})

    with pytest.raises(ProviderError) as info:
        await _openai(handler).generate(MESSAGES, ModelConfig(model="gpt-test"))
    assert "temperature" not in seen
    assert info.value.kind == "rate_limited"
    assert info.value.retryable


@pytest.mark.parametrize(
    ("status", "kind", "retryable"),
    [(400, "bad_request", False), (401, "auth", False), (500, "server_error", True)],
)
async def test_openai_error_classification(status: int, kind: str, retryable: bool) -> None:
    provider = _openai(lambda _: httpx.Response(status, json={"error": {"message": "x"}}))
    with pytest.raises(ProviderError) as info:
        await provider.generate(MESSAGES, ModelConfig(model="gpt-test"))
    assert (info.value.kind, info.value.retryable) == (kind, retryable)


async def test_anthropic_request_shape_and_usage() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.update(json.loads(request.content))
        return httpx2.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-test",
                "content": [{"type": "text", "text": "hello"}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 9, "output_tokens": 3},
            },
        )

    schema = {"type": "object", "properties": {}, "additionalProperties": False}
    result = await _anthropic(handler).generate(
        MESSAGES, ModelConfig(model="claude-test", response_schema=schema)
    )
    assert seen["system"] == "Be terse."
    assert seen["messages"] == [{"role": "user", "content": "Say hi"}]
    assert "temperature" not in seen
    assert seen["output_config"]["format"]["type"] == "json_schema"
    assert result.output == "hello"
    assert (result.input_tokens, result.output_tokens) == (9, 3)


async def test_anthropic_forwards_explicit_temperature_and_classifies_overload() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.update(json.loads(request.content))
        return httpx2.Response(529, json={"type": "error", "error": {"type": "overloaded_error"}})

    with pytest.raises(ProviderError) as info:
        await _anthropic(handler).generate(
            MESSAGES, ModelConfig(model="claude-test", temperature=0.0)
        )
    assert seen["temperature"] == 0.0
    assert info.value.kind == "server_error"
    assert info.value.retryable
