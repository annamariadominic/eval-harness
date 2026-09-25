"""Executes an evaluation run.

Work model: the run's snapshot defines a matrix of (case x variant) *items*, each persisted up
front as a ``pending`` result row. A fixed pool of ``concurrency`` workers drains a queue of
pending items; each worker performs the generation (with retries) and then every evaluator for
that output, and commits the item in a single transaction. Consequences:

* at most ``concurrency`` model requests are in flight (judges run inside the worker's slot);
* progress is simply the count of terminal result rows, readable at any time;
* a crash, restart, or cancellation leaves completed items intact, and resuming processes only
  the rows still pending — succeeded generations are never requested twice;
* one failed generation or evaluator marks that item/score as failed and the run carries on.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from app.analysis.metrics import aggregate_arm
from app.db.base import utcnow
from app.db.models import EvaluatorScore, Result, Run, RunCase, RunEvaluator, RunVariant
from app.domain.statuses import ResultStatus, RunStatus, ScoreStatus
from app.domain.templates import TemplateError, render_template
from app.evaluators.base import EvaluationSample, Evaluator, EvaluatorError, EvaluatorOutcome
from app.evaluators.registry import build_evaluator
from app.pricing import PricingTable
from app.providers.registry import ProviderRegistry
from app.providers.types import Message, ModelConfig
from app.runner.model_calls import PricedModelCaller
from app.runner.retry import CallFailedError, RetryPolicy, Sleep
from app.services.arm_records import load_arm_records

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Snapshot:
    run: Run
    caller: PricedModelCaller
    cases: dict[str, RunCase]
    variants: dict[str, RunVariant]
    evaluators: list[tuple[RunEvaluator, Evaluator | None, str | None]]


def build_messages(variant: RunVariant, case_input: Any) -> list[Message]:
    messages = []
    if variant.system_prompt.strip():
        messages.append(Message(role="system", content=variant.system_prompt))
    messages.append(
        Message(role="user", content=render_template(variant.user_template, case_input))
    )
    return messages


class RunExecutor:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        registry: ProviderRegistry,
        pricing: PricingTable,
        *,
        sleep: Sleep | None = None,
    ) -> None:
        self._sessionmaker = sessionmaker
        self._registry = registry
        self._pricing = pricing
        self._sleep = sleep

    def retry_policy(self, run: Run) -> RetryPolicy:
        return RetryPolicy(max_attempts=run.max_attempts)

    async def execute(self, run_id: str) -> None:
        snapshot, pending = await self._start(run_id)
        queue: asyncio.Queue[str] = asyncio.Queue()
        for result_id in pending:
            queue.put_nowait(result_id)
        worker_count = max(1, min(snapshot.run.concurrency, len(pending)))
        try:
            await asyncio.gather(*(self._worker(snapshot, queue) for _ in range(worker_count)))
        except asyncio.CancelledError:
            await self._finish(run_id, RunStatus.CANCELLED)
            raise
        except Exception as exc:  # the runner itself broke, not a single item
            logger.exception("Run %s failed", run_id)
            await self._finish(run_id, RunStatus.FAILED, error=f"{type(exc).__name__}: {exc}")
            return
        await self._finish(run_id, RunStatus.COMPLETED)

    async def _start(self, run_id: str) -> tuple[_Snapshot, list[str]]:
        async with self._sessionmaker() as session:
            run = await session.scalar(
                select(Run)
                .where(Run.id == run_id)
                .options(
                    selectinload(Run.cases),
                    selectinload(Run.variants),
                    selectinload(Run.evaluators),
                )
            )
            if run is None:
                raise LookupError(f"Run {run_id} not found")
            # Rows left 'running' by an interrupted process are safe to redo: they never committed.
            await session.execute(
                update(Result)
                .where(Result.run_id == run_id, Result.status == ResultStatus.RUNNING)
                .values(status=ResultStatus.PENDING)
            )
            run.status = RunStatus.RUNNING
            run.error = None
            run.started_at = run.started_at or utcnow()
            run.finished_at = None
            await session.commit()
            pending = list(
                (
                    await session.scalars(
                        select(Result.id)
                        .join(RunCase, Result.run_case_id == RunCase.id)
                        .join(RunVariant, Result.run_variant_id == RunVariant.id)
                        .where(Result.run_id == run_id, Result.status == ResultStatus.PENDING)
                        .order_by(RunCase.position, RunVariant.position)
                    )
                ).all()
            )

        caller = PricedModelCaller(
            self._registry, self._pricing, self.retry_policy(run), sleep=self._sleep
        )
        evaluators: list[tuple[RunEvaluator, Evaluator | None, str | None]] = []
        for run_evaluator in run.evaluators:
            try:
                built = build_evaluator(run_evaluator.type, run_evaluator.config, caller)
                evaluators.append((run_evaluator, built, None))
            except Exception as exc:  # e.g. config from an older schema version
                evaluators.append((run_evaluator, None, f"Could not build evaluator: {exc}"))
        snapshot = _Snapshot(
            run=run,
            caller=caller,
            cases={c.id: c for c in run.cases},
            variants={v.id: v for v in run.variants},
            evaluators=evaluators,
        )
        return snapshot, pending

    async def _worker(self, snapshot: _Snapshot, queue: "asyncio.Queue[str]") -> None:
        while True:
            try:
                result_id = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            await self._process(snapshot, result_id)

    async def _process(self, snapshot: _Snapshot, result_id: str) -> None:
        async with self._sessionmaker() as session:
            result = await session.get(Result, result_id)
            if result is None or result.status != ResultStatus.PENDING:
                return
            result.status = ResultStatus.RUNNING
            result.started_at = utcnow()
            await session.commit()

            case = snapshot.cases[result.run_case_id]
            variant = snapshot.variants[result.run_variant_id]
            await self._generate(snapshot.caller, result, case, variant)
            if result.status == ResultStatus.SUCCEEDED:
                sample = EvaluationSample(
                    input=case.input,
                    expected=case.expected,
                    output=result.output or "",
                    metadata=case.meta,
                )
                for run_evaluator, evaluator, build_error in snapshot.evaluators:
                    session.add(
                        await self._evaluate(result, run_evaluator, evaluator, build_error, sample)
                    )
            else:
                for run_evaluator, _, _ in snapshot.evaluators:
                    session.add(
                        EvaluatorScore(
                            result_id=result.id,
                            run_evaluator_id=run_evaluator.id,
                            status=ScoreStatus.SKIPPED,
                            reason="Not evaluated: the generation failed",
                        )
                    )
            result.finished_at = utcnow()
            await session.commit()

    async def _generate(
        self, caller: PricedModelCaller, result: Result, case: RunCase, variant: RunVariant
    ) -> None:
        try:
            messages = build_messages(variant, case.input)
        except TemplateError as exc:
            result.status = ResultStatus.FAILED
            result.error_type = "template_error"
            result.error_message = str(exc)
            return
        result.request_messages = [m.model_dump() for m in messages]
        config = ModelConfig(
            model=variant.model,
            temperature=variant.temperature,
            max_tokens=variant.max_tokens,
            settings=variant.settings,
        )
        try:
            call = await caller(variant.provider, messages, config)
        except CallFailedError as exc:
            result.status = ResultStatus.FAILED
            result.attempts = exc.attempts
            result.error_type = exc.error.kind
            result.error_message = exc.error.message
            return
        except Exception as exc:  # unexpected adapter bug: record it, keep the run going
            logger.exception("Generation crashed for result %s", result.id)
            result.status = ResultStatus.FAILED
            result.error_type = "internal_error"
            result.error_message = f"{type(exc).__name__}: {exc}"
            return
        generation = call.result
        result.status = ResultStatus.SUCCEEDED
        result.output = generation.output
        result.response_model = generation.model
        result.latency_ms = generation.latency_ms
        result.input_tokens = generation.input_tokens
        result.output_tokens = generation.output_tokens
        result.cost_usd = call.cost_usd
        result.attempts = call.attempts

    async def _evaluate(
        self,
        result: Result,
        run_evaluator: RunEvaluator,
        evaluator: Evaluator | None,
        build_error: str | None,
        sample: EvaluationSample,
    ) -> EvaluatorScore:
        score = EvaluatorScore(result_id=result.id, run_evaluator_id=run_evaluator.id)
        if evaluator is None:
            score.status = ScoreStatus.FAILED
            score.error_message = build_error
            return score
        try:
            outcome: EvaluatorOutcome = await evaluator.evaluate(sample)
        except CallFailedError as exc:
            score.status = ScoreStatus.FAILED
            score.error_message = f"Judge call failed after {exc.attempts} attempt(s): {exc}"
            return score
        except EvaluatorError as exc:
            score.status = ScoreStatus.FAILED
            score.error_message = str(exc)
            return score
        except Exception as exc:
            logger.exception("Evaluator %s crashed", run_evaluator.name)
            score.status = ScoreStatus.FAILED
            score.error_message = f"{type(exc).__name__}: {exc}"
            return score
        score.status = ScoreStatus.SUCCEEDED
        score.score = outcome.score
        score.passed = outcome.passed
        score.reason = outcome.reason
        score.details = outcome.details
        if outcome.usage is not None:
            score.latency_ms = outcome.usage.latency_ms
            score.input_tokens = outcome.usage.input_tokens
            score.output_tokens = outcome.usage.output_tokens
            score.cost_usd = outcome.usage.cost_usd
        return score

    async def _finish(self, run_id: str, status: RunStatus, error: str | None = None) -> None:
        async with self._sessionmaker() as session:
            run = await session.get(Run, run_id, options=[selectinload(Run.variants)])
            if run is None:
                return
            if status != RunStatus.COMPLETED:
                await session.execute(
                    update(Result)
                    .where(
                        Result.run_id == run_id,
                        Result.status.in_([ResultStatus.PENDING, ResultStatus.RUNNING]),
                    )
                    .values(status=ResultStatus.CANCELLED)
                )
            run.summary = await compute_run_summary(session, run)
            run.status = status
            run.error = error
            run.finished_at = utcnow()
            await session.commit()


async def compute_run_summary(session: AsyncSession, run: Run) -> dict[str, Any]:
    arms = {}
    for variant in run.variants:
        records = await load_arm_records(session, variant.id)
        arms[variant.id] = aggregate_arm(records).as_dict()
    return {"arms": arms}
