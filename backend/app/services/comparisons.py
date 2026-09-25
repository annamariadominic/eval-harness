"""Assemble comparison reports and per-case inspection views from persisted runs."""

from dataclasses import asdict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.analysis.comparison import compare_case, count_changes, pair_cases
from app.analysis.metrics import ArmMetrics, aggregate_arm
from app.analysis.slices import DEFAULT_SLICE_THRESHOLD, compute_slices
from app.db.models import EvaluatorScore, Result, Run, RunCase, RunVariant
from app.evaluators.registry import EVALUATOR_TYPES
from app.schemas.comparisons import (
    ArmMetricsOut,
    ArmRef,
    ArmResult,
    CaseComparisonOut,
    CaseResults,
    CaseSnapshot,
    ChangeCountsOut,
    ComparisonReport,
    Coverage,
    EvaluatorRef,
    ScoreDetail,
    SliceRowOut,
)
from app.services.arm_records import evaluator_key, load_arm_records
from app.services.errors import InvalidRequestError, NotFoundError


async def _load_arm(session: AsyncSession, run_variant_id: str) -> RunVariant:
    variant = await session.scalar(
        select(RunVariant)
        .where(RunVariant.id == run_variant_id)
        .options(
            selectinload(RunVariant.run).selectinload(Run.suite),
            selectinload(RunVariant.run).selectinload(Run.evaluators),
        )
    )
    if variant is None:
        raise NotFoundError.for_entity("Run variant", run_variant_id)
    return variant


def arm_ref(variant: RunVariant) -> ArmRef:
    run = variant.run
    return ArmRef(
        run_id=run.id,
        run_name=run.name,
        run_status=run.status,
        run_created_at=run.created_at,
        run_variant_id=variant.id,
        variant_name=variant.name,
        provider=variant.provider,
        model=variant.model,
        is_baseline=run.suite.baseline_run_variant_id == variant.id,
    )


def _evaluator_refs(*variants: RunVariant) -> list[EvaluatorRef]:
    refs: dict[str, EvaluatorRef] = {}
    for variant in variants:
        for evaluator in variant.run.evaluators:
            key = evaluator_key(evaluator)
            spec = EVALUATOR_TYPES.get(evaluator.type)
            refs.setdefault(
                key,
                EvaluatorRef(
                    key=key,
                    name=evaluator.name,
                    type=evaluator.type,
                    scoring=spec.scoring if spec else "fractional",
                ),
            )
    return list(refs.values())


async def build_comparison(
    session: AsyncSession,
    target_id: str,
    base_id: str | None = None,
    slice_threshold: float = DEFAULT_SLICE_THRESHOLD,
    slice_evaluator: str | None = None,
) -> ComparisonReport:
    target = await _load_arm(session, target_id)
    target_records = await load_arm_records(session, target.id)

    if base_id is None:
        metrics = aggregate_arm(target_records)
        return ComparisonReport(
            base=None,
            target=arm_ref(target),
            coverage=Coverage(shared=0, base_only=0, target_only=len(target_records)),
            base_metrics=None,
            target_metrics=ArmMetricsOut.model_validate(metrics.as_dict()),
            overall_delta=None,
            counts=None,
            evaluators=_evaluator_refs(target),
            cases=[
                CaseComparisonOut.model_validate(asdict(compare_case(None, c)))
                for c in target_records
            ],
            slices=[
                SliceRowOut.model_validate(asdict(row))
                for row in compute_slices(target_records, evaluator_key=slice_evaluator)
            ],
            slice_threshold=slice_threshold,
            slice_evaluator=slice_evaluator,
        )

    base = await _load_arm(session, base_id)
    if base.run.suite_id != target.run.suite_id:
        raise InvalidRequestError("Only arms from the same suite can be compared")
    base_records = await load_arm_records(session, base.id)

    paired = pair_cases(base_records, target_records)
    shared_base = [b for b, _ in paired.shared]
    shared_target = [t for _, t in paired.shared]
    base_metrics = aggregate_arm(shared_base)
    target_metrics = aggregate_arm(shared_target)
    comparisons = [compare_case(b, t) for b, t in paired.shared]
    overall_delta = (
        target_metrics.overall_score - base_metrics.overall_score
        if target_metrics.overall_score is not None and base_metrics.overall_score is not None
        else None
    )
    slice_overall_delta = overall_delta
    if slice_evaluator is not None:
        slice_overall_delta = _evaluator_delta(base_metrics, target_metrics, slice_evaluator)
    slices = compute_slices(
        shared_target,
        shared_base,
        comparisons,
        overall_delta=slice_overall_delta,
        slice_threshold=slice_threshold,
        evaluator_key=slice_evaluator,
    )
    return ComparisonReport(
        base=arm_ref(base),
        target=arm_ref(target),
        coverage=Coverage(
            shared=len(paired.shared),
            base_only=len(paired.base_only),
            target_only=len(paired.target_only),
        ),
        base_metrics=ArmMetricsOut.model_validate(base_metrics.as_dict()),
        target_metrics=ArmMetricsOut.model_validate(target_metrics.as_dict()),
        overall_delta=overall_delta,
        counts=ChangeCountsOut.model_validate(asdict(count_changes(comparisons))),
        evaluators=_evaluator_refs(target, base),
        cases=[CaseComparisonOut.model_validate(asdict(c)) for c in comparisons],
        slices=[SliceRowOut.model_validate(asdict(row)) for row in slices],
        slice_threshold=slice_threshold,
        slice_evaluator=slice_evaluator,
    )


def _evaluator_delta(base: ArmMetrics, target: ArmMetrics, key: str) -> float | None:
    base_mean = next((e.mean_score for e in base.evaluators if e.evaluator_key == key), None)
    target_mean = next((e.mean_score for e in target.evaluators if e.evaluator_key == key), None)
    if base_mean is None or target_mean is None:
        return None
    return target_mean - base_mean


async def get_case_results(
    session: AsyncSession, test_case_id: str, arm_ids: list[str]
) -> CaseResults:
    if not arm_ids:
        raise InvalidRequestError("Specify at least one arm")
    snapshot: RunCase | None = None
    arms: list[ArmResult] = []
    for arm_id in dict.fromkeys(arm_ids):
        variant = await _load_arm(session, arm_id)
        result = await session.scalar(
            select(Result)
            .join(RunCase, Result.run_case_id == RunCase.id)
            .where(Result.run_variant_id == arm_id, RunCase.test_case_id == test_case_id)
            .options(
                selectinload(Result.case),
                selectinload(Result.scores).selectinload(EvaluatorScore.evaluator),
            )
        )
        if result is None:
            continue
        snapshot = snapshot or result.case
        scores = sorted(result.scores, key=lambda s: s.evaluator.position)
        arms.append(
            ArmResult(
                arm=arm_ref(variant),
                result_id=result.id,
                status=result.status,
                output=result.output,
                request_messages=result.request_messages,
                response_model=result.response_model,
                latency_ms=result.latency_ms,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                total_tokens=result.total_tokens,
                cost_usd=result.cost_usd,
                attempts=result.attempts,
                error_type=result.error_type,
                error_message=result.error_message,
                started_at=result.started_at,
                finished_at=result.finished_at,
                scores=[
                    ScoreDetail(
                        evaluator_key=evaluator_key(s.evaluator),
                        evaluator_name=s.evaluator.name,
                        evaluator_type=s.evaluator.type,
                        status=s.status,
                        score=s.score,
                        passed=s.passed,
                        reason=s.reason,
                        details=s.details,
                        latency_ms=s.latency_ms,
                        input_tokens=s.input_tokens,
                        output_tokens=s.output_tokens,
                        cost_usd=s.cost_usd,
                        error_message=s.error_message,
                    )
                    for s in scores
                ],
            )
        )
    if snapshot is None:
        raise NotFoundError(f"Test case '{test_case_id}' has no results in the requested arms")
    return CaseResults(
        case=CaseSnapshot(
            test_case_id=snapshot.test_case_id,
            key=snapshot.key,
            input=snapshot.input,
            expected=snapshot.expected,
            tags=snapshot.tags,
            metadata=snapshot.meta,
        ),
        arms=arms,
    )
