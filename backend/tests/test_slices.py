import pytest

from app.analysis.comparison import compare_case
from app.analysis.slices import UNTAGGED, compute_slices
from tests.factories import case, score


def test_slices_expose_a_regression_hidden_by_the_aggregate() -> None:
    # Overall the candidate improves (easy cases get much better)
    # while the "hard" slice quietly gets worse.
    base = [
        case("e1", score("q", 0.2), tags=("easy",)),
        case("e2", score("q", 0.2), tags=("easy",)),
        case("h1", score("q", 0.9), tags=("hard", "financial")),
    ]
    target = [
        case("e1", score("q", 1.0), tags=("easy",)),
        case("e2", score("q", 1.0), tags=("easy",)),
        case("h1", score("q", 0.6), tags=("hard", "financial")),
    ]
    comparisons = [compare_case(b, t) for b, t in zip(base, target, strict=True)]
    overall_delta = (2.6 - 1.3) / 3
    rows = {
        r.tag: r for r in compute_slices(target, base, comparisons, overall_delta=overall_delta)
    }

    assert set(rows) == {"easy", "hard", "financial"}
    assert rows["easy"].delta == pytest.approx(0.8)
    assert rows["easy"].improved == 2
    assert rows["hard"].delta == pytest.approx(-0.3)
    assert rows["hard"].regressed == 1
    assert rows["hard"].regressed_slice and rows["hard"].hidden_regression
    assert not rows["easy"].regressed_slice
    assert rows["financial"].cases == 1  # a case can belong to several slices


def test_single_arm_slices_and_untagged_bucket() -> None:
    rows = compute_slices([case("a", score("q", 1.0), tags=("x",)), case("b", score("q", 0.0))])
    assert [r.tag for r in rows] == ["x", UNTAGGED]
    assert rows[0].target_score == 1.0
    assert rows[0].base_score is None and rows[0].delta is None
    assert not any(r.hidden_regression for r in rows)


def test_failed_generations_do_not_count_toward_slice_scores() -> None:
    rows = compute_slices(
        [case("a", score("q", 1.0), tags=("x",)), case("b", tags=("x",), status="failed")]
    )
    assert rows[0].target_score == 1.0
    assert rows[0].cases == 2
