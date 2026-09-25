"""Test doubles that implement the ModelProvider protocol."""

import asyncio
from collections import Counter

from fastapi import FastAPI

from app.providers.registry import ProviderInfo, ProviderRegistry
from app.providers.types import GenerationResult, Message, ModelConfig, ModelProvider, ProviderError
from app.runner.executor import RunExecutor
from app.runner.manager import RunManager


class ScriptedProvider:
    """Behaviour is chosen by model name, so one provider can script many scenarios.

    * ``echo``      — returns the rendered user message
    * ``flaky``     — first attempt for each prompt fails with a retryable 503
    * ``broken``    — always fails with a permanent 400
    * ``slow``      — echo after a short delay (for concurrency/cancellation tests)
    * ``fail:<s>``  — fails permanently when the prompt contains ``<s>``, otherwise echoes
    """

    name = "scripted"

    def __init__(self, delay_s: float = 0.0) -> None:
        self.delay_s = delay_s
        self.calls: Counter[str] = Counter()
        self.in_flight = 0
        self.max_in_flight = 0

    async def generate(self, messages: list[Message], config: ModelConfig) -> GenerationResult:
        prompt = messages[-1].content
        self.calls[prompt] += 1
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            delay = self.delay_s if config.model != "slow" else max(self.delay_s, 0.05)
            await asyncio.sleep(delay)
            if config.model == "broken":
                raise ProviderError("400 invalid request", kind="bad_request", status_code=400)
            if config.model == "flaky" and self.calls[prompt] == 1:
                raise ProviderError("503 unavailable", kind="server_error", status_code=503)
            if config.model.startswith("fail:") and config.model[5:] in prompt:
                raise ProviderError("400 rejected", kind="bad_request", status_code=400)
            return GenerationResult(
                output=prompt,
                latency_ms=10.0,
                input_tokens=len(prompt),
                output_tokens=len(prompt),
                model=config.model,
                provider=self.name,
            )
        finally:
            self.in_flight -= 1


def install_providers(app: FastAPI, **providers: ModelProvider) -> None:
    """Swap the app's registry (and the executor bound to it) for one with extra providers."""
    base = app.state.providers
    merged: dict[str, ModelProvider] = {"mock": base.get("mock"), **providers}
    info = [*base.list_info()] + [
        ProviderInfo(name=name, label=name, description="test", configured=True)
        for name in providers
    ]
    registry = ProviderRegistry(merged, info)
    app.state.providers = registry

    async def no_sleep(_: float) -> None:
        return None

    executor = RunExecutor(app.state.db.sessionmaker, registry, app.state.pricing, sleep=no_sleep)
    app.state.run_manager = RunManager(app.state.db.sessionmaker, executor)
