"""Retry with capped exponential backoff and full jitter for transient provider failures."""

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from typing import Any, TypeVar

from app.providers.types import ProviderError

T = TypeVar("T")
Sleep = Callable[[float], Awaitable[None]]


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_s: float = 0.5
    max_delay_s: float = 8.0

    def delay_for(self, attempt: int, rng: random.Random | None = None) -> float:
        """Delay before the retry that follows ``attempt`` (1-based). Full jitter keeps a burst of
        rate-limited workers from retrying in lockstep."""
        ceiling = min(self.max_delay_s, self.base_delay_s * 2 ** (attempt - 1))
        return (rng or random).uniform(0, ceiling)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class CallFailedError(Exception):
    """Raised when a call fails permanently or exhausts its attempts."""

    def __init__(self, error: ProviderError, attempts: int) -> None:
        super().__init__(error.message)
        self.error = error
        self.attempts = attempts


async def call_with_retry(
    operation: Callable[[], Awaitable[T]],
    policy: RetryPolicy,
    *,
    sleep: Sleep = asyncio.sleep,
    rng: random.Random | None = None,
) -> tuple[T, int]:
    """Run ``operation`` until it succeeds, fails permanently, or runs out of attempts.

    Only :class:`ProviderError` instances marked retryable are retried; anything else is a
    programming error and propagates immediately. Returns ``(value, attempts_used)``.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return await operation(), attempt
        except ProviderError as error:
            if not error.retryable or attempt >= policy.max_attempts:
                raise CallFailedError(error, attempt) from error
            delay = policy.delay_for(attempt, rng)
            if error.retry_after_s is not None:
                delay = max(delay, min(error.retry_after_s, policy.max_delay_s * 4))
            await sleep(delay)
