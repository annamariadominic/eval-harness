"""Suite CRUD and dashboard summaries."""

from collections import Counter
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import Evaluator, Run, Suite, TestCase, Variant
from app.schemas.suites import (
    ArmScore,
    LatestRun,
    SuiteCreate,
    SuiteDetail,
    SuiteSummary,
    SuiteUpdate,
)
from app.services.common import get_or_404


async def create_suite(session: AsyncSession, data: SuiteCreate) -> Suite:
    suite = Suite(name=data.name, description=data.description)
    session.add(suite)
    await session.commit()
    return suite


async def update_suite(session: AsyncSession, suite_id: str, data: SuiteUpdate) -> Suite:
    suite = await get_or_404(session, Suite, suite_id)
    for field, value in data.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(suite, field, value)
    await session.commit()
    return suite


async def delete_suite(session: AsyncSession, suite_id: str) -> None:
    suite = await get_or_404(session, Suite, suite_id)
    await session.delete(suite)
    await session.commit()


async def list_suites(session: AsyncSession) -> list[SuiteSummary]:
    suites = (await session.scalars(select(Suite).order_by(Suite.created_at))).all()
    return [await _summarize(session, suite) for suite in suites]


async def get_suite_detail(session: AsyncSession, suite_id: str) -> SuiteDetail:
    suite = await get_or_404(session, Suite, suite_id)
    summary = await _summarize(session, suite)
    tags = (await session.scalars(select(TestCase.tags).where(TestCase.suite_id == suite_id))).all()
    tag_counts = Counter(tag for case_tags in tags for tag in case_tags)
    return SuiteDetail(**summary.model_dump(), tag_counts=dict(tag_counts.most_common()))


async def _count(session: AsyncSession, model: Any, suite_id: str) -> int:
    return int(
        await session.scalar(
            select(func.count()).select_from(model).where(model.suite_id == suite_id)
        )
        or 0
    )


async def _summarize(session: AsyncSession, suite: Suite) -> SuiteSummary:
    runs = (
        await session.scalars(
            select(Run)
            .where(Run.suite_id == suite.id)
            .options(selectinload(Run.variants))
            .order_by(Run.created_at.desc())
        )
    ).all()

    latest_run: LatestRun | None = None
    if runs:
        latest = runs[0]
        latest_run = LatestRun(
            id=latest.id,
            name=latest.name,
            status=latest.status,
            created_at=latest.created_at,
            best=best_arm(latest),
        )

    baseline: ArmScore | None = None
    if suite.baseline_run_id and suite.baseline_run_variant_id:
        baseline_run = next((r for r in runs if r.id == suite.baseline_run_id), None)
        if baseline_run is not None:
            baseline = arm_score(baseline_run, suite.baseline_run_variant_id)

    delta: float | None = None
    scored_run = next((r for r in runs if r.summary), None)
    if baseline and scored_run and scored_run.id != suite.baseline_run_id:
        best = best_arm(scored_run)
        if best and best.overall_score is not None and baseline.overall_score is not None:
            delta = best.overall_score - baseline.overall_score

    return SuiteSummary(
        id=suite.id,
        name=suite.name,
        description=suite.description,
        test_case_count=await _count(session, TestCase, suite.id),
        variant_count=await _count(session, Variant, suite.id),
        evaluator_count=await _count(session, Evaluator, suite.id),
        run_count=len(runs),
        latest_run=latest_run,
        baseline=baseline,
        delta_vs_baseline=delta,
        created_at=suite.created_at,
        updated_at=suite.updated_at,
    )


def arm_score(run: Run, run_variant_id: str) -> ArmScore | None:
    variant = next((v for v in run.variants if v.id == run_variant_id), None)
    if variant is None:
        return None
    metrics = ((run.summary or {}).get("arms") or {}).get(run_variant_id) or {}
    return ArmScore(
        run_id=run.id,
        run_name=run.name,
        run_variant_id=variant.id,
        variant_name=variant.name,
        overall_score=metrics.get("overall_score"),
        pass_rate=metrics.get("pass_rate"),
    )


def best_arm(run: Run) -> ArmScore | None:
    """The highest-scoring variant in a finished run (the run's headline number)."""
    arms = [a for v in run.variants if (a := arm_score(run, v.id)) is not None]
    scored = [a for a in arms if a.overall_score is not None]
    if not scored:
        return None
    return max(scored, key=lambda a: a.overall_score or 0.0)
