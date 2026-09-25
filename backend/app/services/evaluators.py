"""Evaluator CRUD. Configuration is validated by the evaluator registry before it is stored."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Evaluator, Suite
from app.evaluators.registry import InvalidEvaluatorConfig, normalize_config
from app.schemas.evaluators import EvaluatorCreate, EvaluatorUpdate
from app.services.common import get_or_404
from app.services.errors import ConflictError, InvalidRequestError


def _validated_config(
    type_name: str, config: dict[str, Any], known_providers: set[str]
) -> dict[str, Any]:
    try:
        normalized = normalize_config(type_name, config)
    except InvalidEvaluatorConfig as exc:
        raise InvalidRequestError(str(exc), details=exc.errors) from exc
    provider = normalized.get("provider")
    if type_name == "llm_judge" and provider not in known_providers:
        raise InvalidRequestError(
            f"Unknown judge provider '{provider}'. Available: {', '.join(sorted(known_providers))}"
        )
    return normalized


async def _ensure_name_available(
    session: AsyncSession, suite_id: str, name: str, exclude_id: str | None = None
) -> None:
    query = select(Evaluator.id).where(Evaluator.suite_id == suite_id, Evaluator.name == name)
    if exclude_id:
        query = query.where(Evaluator.id != exclude_id)
    if await session.scalar(query):
        raise ConflictError(f"An evaluator named '{name}' already exists in this suite")


async def list_evaluators(session: AsyncSession, suite_id: str) -> list[Evaluator]:
    await get_or_404(session, Suite, suite_id)
    result = await session.scalars(
        select(Evaluator).where(Evaluator.suite_id == suite_id).order_by(Evaluator.created_at)
    )
    return list(result.all())


async def create_evaluator(
    session: AsyncSession, suite_id: str, data: EvaluatorCreate, known_providers: set[str]
) -> Evaluator:
    await get_or_404(session, Suite, suite_id)
    await _ensure_name_available(session, suite_id, data.name)
    evaluator = Evaluator(
        suite_id=suite_id,
        name=data.name,
        type=data.type,
        config=_validated_config(data.type, data.config, known_providers),
        regression_threshold=data.regression_threshold,
    )
    session.add(evaluator)
    await session.commit()
    return evaluator


async def update_evaluator(
    session: AsyncSession, evaluator_id: str, data: EvaluatorUpdate, known_providers: set[str]
) -> Evaluator:
    """The evaluator type is immutable; create a new evaluator to change what is measured."""
    evaluator = await get_or_404(session, Evaluator, evaluator_id)
    if data.name is not None:
        await _ensure_name_available(session, evaluator.suite_id, data.name, evaluator.id)
        evaluator.name = data.name
    if data.config is not None:
        evaluator.config = _validated_config(evaluator.type, data.config, known_providers)
    if data.regression_threshold is not None:
        evaluator.regression_threshold = data.regression_threshold
    await session.commit()
    return evaluator


async def delete_evaluator(session: AsyncSession, evaluator_id: str) -> None:
    evaluator = await get_or_404(session, Evaluator, evaluator_id)
    await session.delete(evaluator)
    await session.commit()
