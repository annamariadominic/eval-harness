"""Small persistence helpers shared by services."""

from typing import TypeVar

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import Base
from app.services.errors import NotFoundError

ModelT = TypeVar("ModelT", bound=Base)


async def get_or_404(session: AsyncSession, model: type[ModelT], entity_id: str) -> ModelT:
    instance = await session.get(model, entity_id)
    if instance is None:
        raise NotFoundError.for_entity(model.__name__, entity_id)
    return instance
