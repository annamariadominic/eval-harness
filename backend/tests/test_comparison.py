import pytest

from app.analysis.comparison import Change, classify, compare_case, count_changes, pair_cases
from tests.factories import case, score


class TestClassify:
    @pytest.mark.parametrize(
        ("base", "target", "threshold", "expected"),
        [
            (0.92, 0.61, 0.05, Change.REGRESSED),
            (0.61, 0.92, 0.05, Change.IMPROVED),
            (0.80, 0.78, 0.05, Change.UNCHANGED),  # within threshold
            (0.80, 0.75, 0.05, Change.UNCHANGED),  # exactly at threshold is not a regression
            (0.80, 0.74, 0.05, Change.REGRESSED),
            (0.80, 0.79, 0.0, Change.REGRESSED),  # zero threshold: any drop counts
        ],
    )
    def test_threshold_rule(
        self, base: float, target: float, threshold: float, expected: Change
    ) -> None:
        change, delta = classify(
            score("q", base, passed=True), score("q", target, passed=True), threshold
        )
        assert change == expected
        assert delta == pytest.approx(target - base)

    def test_pass_fail_flip_counts_even_within_threshold(self) -> None:
        change, _ = classify(
            score("judge", 0.71, passed=True), score("judge", 0.69, passed=False), 0.05
        )
        assert change == Change.REGRESSED
        change, _ = classify(
            score("judge", 0.69, passed=False), score("judge", 0.71, passed=True), 0.05
        )
        assert change == Change.IMPROVED

    def test_unusable_scores_are_incomparable(self) -> None:
        failed = score("x", None, status="failed")
        assert classify(score("x", 1.0), failed, 0.05) == (Change.INCOMPARABLE, None)
        assert classify(None, score("x", 1.0), 0.05) == (Change.INCOMPARABLE, None)


class TestCompareCase:
    def test_case_regresses_if_any_evaluator_regresses(self) -> None:
        base = case("c1", score("correct", 0.9), score("format", 0.0, passed=False))
        target = case("c1", score("correct", 0.5), score("format", 1.0, passed=True))
        result = compare_case(base, target)
        assert result.change == Change.REGRESSED
        assert result.mixed is True
        by_key = {d.evaluator_key: d.change for d in result.evaluators}
        assert by_key == {"correct": Change.REGRESSED, "format": Change.IMPROVED}
        assert result.delta == pytest.approx(0.75 - 0.45)

    def test_improved_and_unchanged(self) -> None:
        improved = compare_case(
            case("c", score("a", 0.2), score("b", 1.0)), case("c", score("a", 0.9), score("b", 1.0))
        )
        assert improved.change == Change.IMPROVED
        unchanged = compare_case(case("c", score("a", 1.0)), case("c", score("a", 1.0)))
        assert unchanged.change == Change.UNCHANGED

    def test_uses_per_evaluator_thresholds(self) -> None:
        lenient = compare_case(
            case("c", score("judge", 0.9, threshold=0.2)),
            case("c", score("judge", 0.75, threshold=0.2)),
        )
        assert lenient.change == Change.UNCHANGED

    def test_generation_failure_is_incomparable_not_a_regression(self) -> None:
        base = case("c", score("a", 1.0))
        target = case("c", score("a", None, status="skipped"), status="failed")
        result = compare_case(base, target)
        assert result.change == Change.INCOMPARABLE
        assert result.target_status == "failed"

    def test_new_evaluator_on_one_side_is_incomparable(self) -> None:
        result = compare_case(
            case("c", score("a", 1.0)), case("c", score("a", 1.0), score("new", 0.0))
        )
        assert result.change == Change.UNCHANGED
        assert {d.evaluator_key: d.change for d in result.evaluators}["new"] == (
            Change.INCOMPARABLE
        )


def test_pairing_and_counts() -> None:
    base = [case("a", score("x", 1.0)), case("b", score("x", 1.0)), case("gone", score("x", 1.0))]
    target = [case("a", score("x", 0.0)), case("b", score("x", 1.0)), case("new", score("x", 1.0))]
    paired = pair_cases(base, target)
    assert [t.test_case_id for _, t in paired.shared] == ["a", "b"]
    assert [c.test_case_id for c in paired.base_only] == ["gone"]
    assert [c.test_case_id for c in paired.target_only] == ["new"]
    counts = count_changes([compare_case(b, t) for b, t in paired.shared])
    assert (counts.improved, counts.regressed, counts.unchanged) == (0, 1, 1)
