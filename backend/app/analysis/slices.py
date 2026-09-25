"""Performance by tag ("slices"), with detection of regressions hidden by the aggregate.

For each tag, the slice score is the mean case score over the cases carrying that tag (cases
can belong to several slices). A slice is flagged as **regressed** when its score drops by more
than ``slice_threshold``, and as a **hidden regression** when that happens while the overall
score held steady or improved — exactly the situation a single headline number conceals.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from app.analysis.comparison import CaseComparison, Change
from app.analysis.metrics import mean
from app.analysis.records import CaseRecord

UNTAGGED = "(untagged)"
DEFAULT_SLICE_THRESHOLD = 0.02


@dataclass(frozen=True)
class SliceRow:
    tag: str
    cases: int
    base_score: float | None
    target_score: float | None
    delta: float | None
    base_pass_rate: float | None
    target_pass_rate: float | None
    improved: int
    regressed: int
    regressed_slice: bool
    hidden_regression: bool


def _tags_of(case: CaseRecord) -> tuple[str, ...]:
    return case.tags or (UNTAGGED,)


def _score(
    cases: Sequence[CaseRecord], evaluator_key: str | None
) -> tuple[float | None, float | None]:
    scored = [c for c in cases if c.succeeded]
    if evaluator_key is None:
        return (
            mean(s for c in scored if (s := c.score) is not None),
            mean(1.0 if p else 0.0 for c in scored if (p := c.passed) is not None),
        )
    records = [r for c in scored if (r := c.score_for(evaluator_key)) is not None and r.usable]
    return (
        mean(r.score for r in records if r.score is not None),
        mean(1.0 if r.passed else 0.0 for r in records if r.passed is not None),
    )


def compute_slices(
    target_cases: Sequence[CaseRecord],
    base_cases: Sequence[CaseRecord] | None = None,
    comparisons: Sequence[CaseComparison] = (),
    *,
    overall_delta: float | None = None,
    slice_threshold: float = DEFAULT_SLICE_THRESHOLD,
    evaluator_key: str | None = None,
) -> list[SliceRow]:
    """``target_cases`` and ``base_cases`` should already be restricted to shared cases.

    With ``evaluator_key``, slices use that evaluator's scores instead of case scores (and
    ``overall_delta`` should be that evaluator's overall delta), so a regression in one quality
    dimension is not masked by gains in another.
    """
    tags = sorted({t for c in target_cases for t in _tags_of(c)}, key=lambda t: (t == UNTAGGED, t))
    comparison_by_case = {c.test_case_id: c for c in comparisons}
    rows: list[SliceRow] = []
    for tag in tags:
        target_slice = [c for c in target_cases if tag in _tags_of(c)]
        base_slice = [c for c in base_cases or () if tag in _tags_of(c)]
        target_score, target_pass = _score(target_slice, evaluator_key)
        base_score, base_pass = (
            _score(base_slice, evaluator_key) if base_cases is not None else (None, None)
        )
        delta = (
            target_score - base_score
            if target_score is not None and base_score is not None
            else None
        )
        changes = [
            _change_for(comparison_by_case[c.test_case_id], evaluator_key)
            for c in target_slice
            if c.test_case_id in comparison_by_case
        ]
        regressed_slice = delta is not None and delta < -slice_threshold
        rows.append(
            SliceRow(
                tag=tag,
                cases=len(target_slice),
                base_score=base_score,
                target_score=target_score,
                delta=delta,
                base_pass_rate=base_pass,
                target_pass_rate=target_pass,
                improved=changes.count(Change.IMPROVED),
                regressed=changes.count(Change.REGRESSED),
                regressed_slice=regressed_slice,
                hidden_regression=regressed_slice
                and overall_delta is not None
                and overall_delta >= 0,
            )
        )
    return rows


def _change_for(comparison: CaseComparison, evaluator_key: str | None) -> Change:
    if evaluator_key is None:
        return comparison.change
    delta = next((d for d in comparison.evaluators if d.evaluator_key == evaluator_key), None)
    return delta.change if delta else Change.INCOMPARABLE
