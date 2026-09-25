import pytest

from app.analysis.metrics import aggregate_arm, percentile
from tests.factories import case, score


def test_overall_score_is_mean_of_case_means() -> None:
    metrics = aggregate_arm(
        [
            case("a", score("correct", 1.0), score("format", 0.0)),  # case score 0.5
            case("b", score("correct", 1.0)),  # case score 1.0 (format missing)
        ]
    )
    assert metrics.overall_score == pytest.approx(0.75)
    assert metrics.pass_rate == pytest.approx(0.5)
    by_key = {e.evaluator_key: e for e in metrics.evaluators}
    assert by_key["correct"].mean_score == pytest.approx(1.0)
    assert by_key["format"].mean_score == pytest.approx(0.0)
    assert by_key["format"].scored == 1


def test_failed_generations_are_excluded_from_quality_but_counted() -> None:
    metrics = aggregate_arm(
        [
            case("a", score("correct", 0.8)),
            case("b", score("correct", None, status="skipped"), status="failed", cost=None),
            case("c", status="pending", latency=None, cost=None),
        ]
    )
    assert metrics.overall_score == pytest.approx(0.8)
    assert (metrics.total_cases, metrics.succeeded, metrics.failed, metrics.pending) == (3, 1, 1, 1)
    assert metrics.scored_cases == 1


def test_evaluator_errors_are_counted_not_averaged() -> None:
    metrics = aggregate_arm(
        [
            case("a", score("judge", 0.6)),
            case("b", score("judge", None, status="failed")),
        ]
    )
    judge = metrics.evaluators[0]
    assert judge.mean_score == pytest.approx(0.6)
    assert (judge.scored, judge.errors) == (1, 1)


def test_operational_metrics() -> None:
    metrics = aggregate_arm(
        [
            case("a", score("x", 1.0, cost=0.002), latency=100, cost=0.01, tokens=(100, 10)),
            case("b", score("x", 1.0), latency=300, cost=None, tokens=(50, 5), attempts=2),
        ]
    )
    assert metrics.latency.mean_ms == pytest.approx(200)
    assert metrics.latency.p95_ms == 300
    assert (metrics.input_tokens, metrics.output_tokens) == (150, 15)
    assert metrics.generation_cost_usd == pytest.approx(0.01)
    assert metrics.judge_cost_usd == pytest.approx(0.002)
    assert metrics.total_cost_usd == pytest.approx(0.012)
    assert metrics.cost_complete is False  # case b had no pricing
    assert metrics.retried_generations == 1
    assert metrics.as_dict()["total_tokens"] == 165


def test_empty_arm() -> None:
    metrics = aggregate_arm([])
    assert metrics.overall_score is None
    assert metrics.pass_rate is None
    assert metrics.total_cost_usd is None


def test_percentile_nearest_rank() -> None:
    values = [float(v) for v in range(1, 11)]
    assert percentile(values, 50) == 5
    assert percentile(values, 95) == 10
    assert percentile([], 50) is None
