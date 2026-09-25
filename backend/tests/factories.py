"""Builders for analysis records used across tests."""

from app.analysis.records import CaseRecord, ScoreRecord


def score(
    key: str,
    value: float | None,
    passed: bool | None = None,
    *,
    status: str = "succeeded",
    threshold: float = 0.05,
    cost: float | None = None,
) -> ScoreRecord:
    return ScoreRecord(
        evaluator_key=key,
        evaluator_name=key.title(),
        status=status,
        score=value,
        passed=(value is not None and value >= 0.5) if passed is None else passed,
        regression_threshold=threshold,
        cost_usd=cost,
    )


def case(
    case_id: str,
    *scores: ScoreRecord,
    tags: tuple[str, ...] = (),
    status: str = "succeeded",
    latency: float | None = 100.0,
    cost: float | None = 0.01,
    tokens: tuple[int, int] = (100, 20),
    attempts: int = 1,
) -> CaseRecord:
    return CaseRecord(
        test_case_id=case_id,
        key=case_id,
        tags=tags,
        status=status,
        latency_ms=latency,
        input_tokens=tokens[0],
        output_tokens=tokens[1],
        cost_usd=cost,
        attempts=attempts,
        scores=scores,
    )
