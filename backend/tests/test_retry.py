import random

import pytest

from app.providers.types import ProviderError
from app.runner.retry import CallFailedError, RetryPolicy, call_with_retry


class Recorder:
    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


def flaky(failures: list[ProviderError]):  # type: ignore[no-untyped-def]
    calls = {"n": 0}

    async def operation() -> str:
        calls["n"] += 1
        if failures:
            raise failures.pop(0)
        return "ok"

    return operation, calls


async def test_retries_transient_errors_until_success() -> None:
    operation, calls = flaky(
        [ProviderError("503", kind="server_error"), ProviderError("429", kind="rate_limited")]
    )
    sleep = Recorder()
    value, attempts = await call_with_retry(operation, RetryPolicy(max_attempts=3), sleep=sleep)
    assert (value, attempts, calls["n"]) == ("ok", 3, 3)
    assert len(sleep.delays) == 2


async def test_permanent_errors_are_not_retried() -> None:
    operation, calls = flaky([ProviderError("bad", kind="bad_request")])
    with pytest.raises(CallFailedError) as info:
        await call_with_retry(operation, RetryPolicy(), sleep=Recorder())
    assert calls["n"] == 1
    assert info.value.attempts == 1
    assert info.value.error.kind == "bad_request"


async def test_gives_up_after_max_attempts() -> None:
    operation, calls = flaky([ProviderError("t", kind="timeout") for _ in range(5)])
    with pytest.raises(CallFailedError) as info:
        await call_with_retry(operation, RetryPolicy(max_attempts=2), sleep=Recorder())
    assert calls["n"] == 2
    assert info.value.attempts == 2


async def test_honours_retry_after() -> None:
    operation, _ = flaky([ProviderError("429", kind="rate_limited", retry_after_s=3.0)])
    sleep = Recorder()
    await call_with_retry(operation, RetryPolicy(base_delay_s=0.1), sleep=sleep)
    assert sleep.delays == [3.0]


def test_backoff_is_capped_exponential_with_jitter() -> None:
    policy = RetryPolicy(base_delay_s=1.0, max_delay_s=4.0)
    rng = random.Random(0)
    for attempt, ceiling in [(1, 1.0), (2, 2.0), (3, 4.0), (6, 4.0)]:
        assert 0 <= policy.delay_for(attempt, rng) <= ceiling
