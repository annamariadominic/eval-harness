"""Load persisted results into analysis records."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.analysis.records import CaseRecord, ScoreRecord
from app.db.models import EvaluatorScore, Result, RunCase, RunEvaluator


def evaluator_key(evaluator: RunEvaluator) -> str:
    return evaluator.evaluator_id or f"name:{evaluator.name}"


async def load_arm_records(session: AsyncSession, run_variant_id: str) -> list[CaseRecord]:
    results = (
        await session.scalars(
            select(Result)
            .join(RunCase, Result.run_case_id == RunCase.id)
            .where(Result.run_variant_id == run_variant_id)
            .options(
                selectinload(Result.case),
                selectinload(Result.scores).selectinload(EvaluatorScore.evaluator),
            )
            .order_by(RunCase.position)
        )
    ).all()
    return [to_case_record(result) for result in results]


def to_case_record(result: Result) -> CaseRecord:
    scores = sorted(result.scores, key=lambda s: s.evaluator.position)
    return CaseRecord(
        test_case_id=result.case.test_case_id,
        key=result.case.key,
        tags=tuple(result.case.tags),
        status=result.status,
        latency_ms=result.latency_ms,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cost_usd=result.cost_usd,
        attempts=result.attempts,
        error_type=result.error_type,
        scores=tuple(
            ScoreRecord(
                evaluator_key=evaluator_key(s.evaluator),
                evaluator_name=s.evaluator.name,
                status=s.status,
                score=s.score,
                passed=s.passed,
                regression_threshold=s.evaluator.regression_threshold,
                reason=s.reason,
                cost_usd=s.cost_usd,
            )
            for s in scores
        ),
    )
