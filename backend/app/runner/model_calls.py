"""The runner's single path to a model: provider lookup, retries, and cost estimation."""

import asyncio

from app.evaluators.base import ModelCall
from app.pricing import PricingTable
from app.providers.registry import ProviderRegistry
from app.providers.types import Message, ModelConfig, ProviderError
from app.runner.retry import CallFailedError, RetryPolicy, Sleep, call_with_retry


class PricedModelCaller:
    """Implements :class:`app.evaluators.base.ModelCaller` for generations and judges alike."""

    def __init__(
        self,
        registry: ProviderRegistry,
        pricing: PricingTable,
        policy: RetryPolicy,
        sleep: Sleep | None = None,
    ) -> None:
        self._registry = registry
        self._pricing = pricing
        self._policy = policy
        self._sleep = sleep or asyncio.sleep

    async def __call__(
        self, provider: str, messages: list[Message], config: ModelConfig
    ) -> ModelCall:
        try:
            adapter = self._registry.get(provider)
        except ProviderError as error:
            raise CallFailedError(error, attempts=0) from error

        result, attempts = await call_with_retry(
            lambda: adapter.generate(messages, config), self._policy, sleep=self._sleep
        )
        cost = self._pricing.estimate(
            provider, config.model, result.input_tokens, result.output_tokens
        )
        return ModelCall(result=result, cost_usd=cost, attempts=attempts)
