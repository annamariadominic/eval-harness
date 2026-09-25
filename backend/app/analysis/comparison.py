"""Pairwise comparison of two arms and regression detection.

Pairing: cases are matched by ``test_case_id`` and evaluators by their stable key, so an arm
from last week's baseline run compares cleanly against today's candidate even if the variant
or evaluator has since been renamed.

Regression rule, applied per (case, evaluator):

* **regressed** — the score dropped by more than the evaluator's ``regression_threshold``, or
  the verdict flipped from pass to fail;
* **improved** — the mirror image: a rise beyond the threshold, or a fail-to-pass flip;
* **unchanged** — anything within the threshold with the same verdict;
* **incomparable** — either side has no usable score (generation or evaluator failed).

A case is *regressed* if any of its evaluators regressed (flagged ``mixed`` when others
improved), *improved* if at least one improved and none regressed, *unchanged* when every
comparable evaluator was unchanged, and *incomparable* when nothing could be compared.
Generation failures never count as regressions or improvements; they surface as errors.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from app.analysis.records import CaseRecord, ScoreRecord

EPSILON = 1e-9
DEFAULT_THRESHOLD = 0.05


class Change(StrEnum):
    IMPROVED = "improved"
    REGRESSED = "regressed"
    UNCHANGED = "unchanged"
    INCOMPARABLE = "incomparable"


@dataclass(frozen=True)
class EvaluatorDelta:
    evaluator_key: str
    evaluator_name: str
    threshold: float
    base_score: float | None
    target_score: float | None
    base_passed: bool | None
    target_passed: bool | None
    delta: float | None
    change: Change


@dataclass(frozen=True)
class CaseComparison:
    test_case_id: str
    key: str | None
    tags: tuple[str, ...]
    base_status: str | None
    target_status: str | None
    base_score: float | None
    target_score: float | None
    delta: float | None
    change: Change
    mixed: bool = False
    evaluators: list[EvaluatorDelta] = field(default_factory=list)


@dataclass(frozen=True)
class ChangeCounts:
    improved: int = 0
    regressed: int = 0
    unchanged: int = 0
    incomparable: int = 0


def classify(
    base: ScoreRecord | None, target: ScoreRecord | None, threshold: float
) -> tuple[Change, float | None]:
    if base is None or target is None or not base.usable or not target.usable:
        return Change.INCOMPARABLE, None
    assert base.score is not None and target.score is not None
    delta = target.score - base.score
    if delta < -threshold - EPSILON or (base.passed is True and target.passed is False):
        return Change.REGRESSED, delta
    if delta > threshold + EPSILON or (base.passed is False and target.passed is True):
        return Change.IMPROVED, delta
    return Change.UNCHANGED, delta


def compare_case(base: CaseRecord | None, target: CaseRecord) -> CaseComparison:
    keys: dict[str, str] = {}
    for record in (*(base.scores if base else ()), *target.scores):
        keys.setdefault(record.evaluator_key, record.evaluator_name)

    deltas: list[EvaluatorDelta] = []
    for key, name in keys.items():
        base_score = base.score_for(key) if base else None
        target_score = target.score_for(key)
        # The candidate's threshold wins: it reflects the evaluator's current configuration.
        reference = target_score or base_score
        threshold = reference.regression_threshold if reference else DEFAULT_THRESHOLD
        change, delta = classify(base_score, target_score, threshold)
        deltas.append(
            EvaluatorDelta(
                evaluator_key=key,
                evaluator_name=name,
                threshold=threshold,
                base_score=base_score.score if base_score else None,
                target_score=target_score.score if target_score else None,
                base_passed=base_score.passed if base_score else None,
                target_passed=target_score.passed if target_score else None,
                delta=delta,
                change=change,
            )
        )

    changes = {d.change for d in deltas}
    if Change.REGRESSED in changes:
        change = Change.REGRESSED
    elif Change.IMPROVED in changes:
        change = Change.IMPROVED
    elif Change.UNCHANGED in changes:
        change = Change.UNCHANGED
    else:
        change = Change.INCOMPARABLE

    base_case_score = base.score if base else None
    target_case_score = target.score
    delta = (
        target_case_score - base_case_score
        if base_case_score is not None and target_case_score is not None
        else None
    )
    return CaseComparison(
        test_case_id=target.test_case_id,
        key=target.key,
        tags=target.tags,
        base_status=base.status if base else None,
        target_status=target.status,
        base_score=base_case_score,
        target_score=target_case_score,
        delta=delta,
        change=change,
        mixed=Change.REGRESSED in changes and Change.IMPROVED in changes,
        evaluators=deltas,
    )


@dataclass(frozen=True)
class PairedCases:
    shared: list[tuple[CaseRecord, CaseRecord]]
    base_only: list[CaseRecord]
    target_only: list[CaseRecord]


def pair_cases(base: Sequence[CaseRecord], target: Sequence[CaseRecord]) -> PairedCases:
    base_by_id = {c.test_case_id: c for c in base}
    target_ids = {c.test_case_id for c in target}
    return PairedCases(
        shared=[(base_by_id[c.test_case_id], c) for c in target if c.test_case_id in base_by_id],
        base_only=[c for c in base if c.test_case_id not in target_ids],
        target_only=[c for c in target if c.test_case_id not in base_by_id],
    )


def count_changes(comparisons: Sequence[CaseComparison]) -> ChangeCounts:
    return ChangeCounts(
        improved=sum(1 for c in comparisons if c.change == Change.IMPROVED),
        regressed=sum(1 for c in comparisons if c.change == Change.REGRESSED),
        unchanged=sum(1 for c in comparisons if c.change == Change.UNCHANGED),
        incomparable=sum(1 for c in comparisons if c.change == Change.INCOMPARABLE),
    )
