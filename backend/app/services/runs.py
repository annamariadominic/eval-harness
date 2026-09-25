"""Run lifecycle: snapshotting configuration at launch, reading progress, cancel and resume."""

import platform
import sys
from collections import Counter
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app import __version__
from app.config import Settings
from app.db.models import (
    Evaluator,
    EvaluatorScore,
    Result,
    Run,
    RunCase,
    RunEvaluator,
    RunVariant,
    Suite,
    TestCase,
    Variant,
)
from app.domain.statuses import ResultStatus, RunStatus
from app.pricing import PricingTable
from app.providers.registry import ProviderRegistry
from app.providers.types import ProviderError
from app.runner.manager import RunManager
from app.runner.retry import RetryPolicy
from app.schemas.runs import (
    RunCreate,
    RunDetail,
    RunEvaluatorOut,
    RunOut,
    RunProgress,
    RunVariantOut,
)
from app.services.common import get_or_404
from app.services.errors import ConflictError, InvalidRequestError, NotFoundError


def _require_provider(registry: ProviderRegistry, provider: str, context: str) -> None:
    try:
        registry.get(provider)
    except ProviderError as exc:
        raise InvalidRequestError(f"{context}: {exc.message}") from exc


async def _select_in_order(
    session: AsyncSession, model: Any, suite_id: str, ids: list[str], label: str
) -> list[Any]:
    rows: list[Any] = list(
        (
            await session.scalars(
                select(model).where(model.suite_id == suite_id, model.id.in_(ids))
            )
        ).all()
    )
    by_id = {row.id: row for row in rows}
    missing = [i for i in dict.fromkeys(ids) if i not in by_id]
    if missing:
        raise InvalidRequestError(f"Unknown {label} for this suite: {', '.join(missing)}")
    return [by_id[i] for i in dict.fromkeys(ids)]


async def create_run(
    session: AsyncSession,
    suite_id: str,
    data: RunCreate,
    *,
    registry: ProviderRegistry,
    pricing: PricingTable,
    settings: Settings,
) -> Run:
    suite = await get_or_404(session, Suite, suite_id)
    variants: list[Variant] = await _select_in_order(
        session, Variant, suite_id, data.variant_ids, "variants"
    )
    evaluators: list[Evaluator] = await _select_in_order(
        session, Evaluator, suite_id, data.evaluator_ids, "evaluators"
    )

    cases = list(
        (
            await session.scalars(
                select(TestCase).where(TestCase.suite_id == suite_id).order_by(TestCase.created_at)
            )
        ).all()
    )
    if data.test_case_ids is not None:
        wanted = set(data.test_case_ids)
        unknown = wanted - {c.id for c in cases}
        if unknown:
            raise InvalidRequestError(f"Unknown test cases: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c.id in wanted]
    if data.tags:
        tags = set(data.tags)
        cases = [c for c in cases if tags & set(c.tags)]
    if not cases:
        raise InvalidRequestError("The selection contains no test cases")

    for variant in variants:
        _require_provider(registry, variant.provider, f"Variant '{variant.name}'")
    for evaluator in evaluators:
        if evaluator.type == "llm_judge":
            _require_provider(registry, evaluator.config["provider"], f"Judge '{evaluator.name}'")

    concurrency = data.concurrency or settings.default_concurrency
    if concurrency > settings.max_concurrency:
        raise InvalidRequestError(
            f"Concurrency {concurrency} exceeds the maximum of {settings.max_concurrency}"
        )

    run_count = await session.scalar(
        select(func.count()).select_from(Run).where(Run.suite_id == suite_id)
    )
    run = Run(
        suite_id=suite.id,
        name=data.name or f"Run {int(run_count or 0) + 1}",
        notes=data.notes,
        status=RunStatus.QUEUED,
        concurrency=concurrency,
        max_attempts=data.max_attempts,
        execution=_execution_metadata(variants, evaluators, pricing, data, concurrency),
    )
    session.add(run)
    await session.flush()

    run_cases = [
        RunCase(
            run_id=run.id,
            test_case_id=c.id,
            position=i,
            key=c.key,
            input=c.input,
            expected=c.expected,
            tags=list(c.tags),
            meta=dict(c.meta),
        )
        for i, c in enumerate(cases)
    ]
    run_variants = [
        RunVariant(
            run_id=run.id,
            variant_id=v.id,
            position=i,
            name=v.name,
            provider=v.provider,
            model=v.model,
            system_prompt=v.system_prompt,
            user_template=v.user_template,
            temperature=v.temperature,
            max_tokens=v.max_tokens,
            settings=dict(v.settings),
        )
        for i, v in enumerate(variants)
    ]
    run_evaluators = [
        RunEvaluator(
            run_id=run.id,
            evaluator_id=e.id,
            position=i,
            name=e.name,
            type=e.type,
            config=dict(e.config),
            regression_threshold=e.regression_threshold,
        )
        for i, e in enumerate(evaluators)
    ]
    session.add_all([*run_cases, *run_variants, *run_evaluators])
    await session.flush()
    session.add_all(
        Result(run_id=run.id, run_case_id=rc.id, run_variant_id=rv.id)
        for rc in run_cases
        for rv in run_variants
    )
    await session.commit()
    return run


def _execution_metadata(
    variants: list[Variant],
    evaluators: list[Evaluator],
    pricing: PricingTable,
    data: RunCreate,
    concurrency: int,
) -> dict[str, Any]:
    models = {(v.provider, v.model) for v in variants} | {
        (e.config["provider"], e.config["model"]) for e in evaluators if e.type == "llm_judge"
    }
    prices = {}
    for provider, model in sorted(models):
        price = pricing.lookup(provider, model)
        prices[f"{provider}/{model}"] = (
            {"input_per_mtok": price.input_per_mtok, "output_per_mtok": price.output_per_mtok}
            if price
            else None
        )
    return {
        "app_version": __version__,
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "concurrency": concurrency,
        "retry_policy": RetryPolicy(max_attempts=data.max_attempts).as_dict(),
        "selection": {
            "test_case_ids": data.test_case_ids,
            "tags": data.tags,
        },
        "pricing": prices,
    }


async def _progress(session: AsyncSession, run_ids: list[str]) -> dict[str, RunProgress]:
    rows = await session.execute(
        select(Result.run_id, Result.status, func.count())
        .where(Result.run_id.in_(run_ids))
        .group_by(Result.run_id, Result.status)
    )
    counts: dict[str, Counter[str]] = {run_id: Counter() for run_id in run_ids}
    for run_id, status, count in rows:
        counts[run_id][status] = count
    return {
        run_id: RunProgress(
            total=sum(c.values()),
            pending=c[ResultStatus.PENDING],
            running=c[ResultStatus.RUNNING],
            succeeded=c[ResultStatus.SUCCEEDED],
            failed=c[ResultStatus.FAILED],
            cancelled=c[ResultStatus.CANCELLED],
        )
        for run_id, c in counts.items()
    }


def _load_options() -> list[Any]:
    return [
        selectinload(Run.variants),
        selectinload(Run.evaluators),
        selectinload(Run.suite),
    ]


async def _case_counts(session: AsyncSession, run_ids: list[str]) -> dict[str, int]:
    rows = await session.execute(
        select(RunCase.run_id, func.count())
        .where(RunCase.run_id.in_(run_ids))
        .group_by(RunCase.run_id)
    )
    return {run_id: count for run_id, count in rows}


def _to_out(run: Run, progress: RunProgress, case_count: int) -> dict[str, Any]:
    return {
        "id": run.id,
        "suite_id": run.suite_id,
        "suite_name": run.suite.name,
        "name": run.name,
        "notes": run.notes,
        "status": run.status,
        "concurrency": run.concurrency,
        "max_attempts": run.max_attempts,
        "error": run.error,
        "created_at": run.created_at,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "case_count": case_count,
        "progress": progress,
        "is_baseline": run.suite.baseline_run_id == run.id,
        "variants": [RunVariantOut.model_validate(v) for v in run.variants],
        "evaluators": [RunEvaluatorOut.model_validate(e) for e in run.evaluators],
        "summary": run.summary,
    }


async def list_runs(session: AsyncSession, suite_id: str | None = None) -> list[RunOut]:
    query = select(Run).options(*_load_options()).order_by(Run.created_at.desc())
    if suite_id is not None:
        await get_or_404(session, Suite, suite_id)
        query = query.where(Run.suite_id == suite_id)
    runs = (await session.scalars(query)).all()
    ids = [r.id for r in runs]
    progress = await _progress(session, ids)
    case_counts = await _case_counts(session, ids)
    return [RunOut(**_to_out(r, progress[r.id], case_counts.get(r.id, 0))) for r in runs]


async def get_run_detail(session: AsyncSession, run_id: str) -> RunDetail:
    run = await session.scalar(select(Run).where(Run.id == run_id).options(*_load_options()))
    if run is None:
        raise NotFoundError.for_entity("Run", run_id)
    progress = (await _progress(session, [run_id]))[run_id]
    case_tags = (await session.scalars(select(RunCase.tags).where(RunCase.run_id == run_id))).all()
    tags = sorted({tag for tags in case_tags for tag in tags})
    return RunDetail(**_to_out(run, progress, len(case_tags)), execution=run.execution, tags=tags)


async def delete_run(session: AsyncSession, manager: RunManager, run_id: str) -> None:
    run = await get_or_404(session, Run, run_id)
    if manager.is_active(run_id):
        raise ConflictError("Cancel the run before deleting it")
    await session.execute(
        update(Suite)
        .where(Suite.baseline_run_id == run_id)
        .values(baseline_run_id=None, baseline_run_variant_id=None)
    )
    await session.delete(run)
    await session.commit()


async def cancel_run(session: AsyncSession, manager: RunManager, run_id: str) -> None:
    run = await get_or_404(session, Run, run_id)
    if await manager.cancel(run_id):
        return
    if RunStatus(run.status).is_active:
        # Queued but never picked up (or orphaned): settle it directly.
        await session.execute(
            update(Result)
            .where(
                Result.run_id == run_id,
                Result.status.in_([ResultStatus.PENDING, ResultStatus.RUNNING]),
            )
            .values(status=ResultStatus.CANCELLED)
        )
        run.status = RunStatus.CANCELLED
        await session.commit()
        return
    raise ConflictError(f"Run is already {run.status}")


async def resume_run(
    session: AsyncSession, manager: RunManager, run_id: str, *, retry_failed: bool
) -> None:
    run = await get_or_404(session, Run, run_id)
    if manager.is_active(run_id):
        raise ConflictError("Run is already executing")
    reset = [ResultStatus.CANCELLED, ResultStatus.PENDING, ResultStatus.RUNNING]
    if retry_failed:
        reset.append(ResultStatus.FAILED)
    ids = (
        await session.scalars(
            select(Result.id).where(Result.run_id == run_id, Result.status.in_(reset))
        )
    ).all()
    if not ids:
        raise ConflictError("Nothing to resume: every generation has already completed")
    await session.execute(delete(EvaluatorScore).where(EvaluatorScore.result_id.in_(ids)))
    await session.execute(
        update(Result)
        .where(Result.id.in_(ids))
        .values(
            status=ResultStatus.PENDING,
            output=None,
            error_type=None,
            error_message=None,
            attempts=0,
            latency_ms=None,
            input_tokens=None,
            output_tokens=None,
            cost_usd=None,
            started_at=None,
            finished_at=None,
        )
    )
    run.status = RunStatus.QUEUED
    run.error = None
    await session.commit()
    manager.start(run_id)
