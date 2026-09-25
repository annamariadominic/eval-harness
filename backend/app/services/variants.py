"""Variant CRUD."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Suite, Variant
from app.schemas.variants import VariantCreate, VariantUpdate
from app.services.common import get_or_404
from app.services.errors import ConflictError, InvalidRequestError


def _check_provider(provider: str, known_providers: set[str]) -> None:
    if provider not in known_providers:
        raise InvalidRequestError(
            f"Unknown provider '{provider}'. Available: {', '.join(sorted(known_providers))}"
        )


async def _ensure_name_available(
    session: AsyncSession, suite_id: str, name: str, exclude_id: str | None = None
) -> None:
    query = select(Variant.id).where(Variant.suite_id == suite_id, Variant.name == name)
    if exclude_id:
        query = query.where(Variant.id != exclude_id)
    if await session.scalar(query):
        raise ConflictError(f"A variant named '{name}' already exists in this suite")


async def list_variants(session: AsyncSession, suite_id: str) -> list[Variant]:
    await get_or_404(session, Suite, suite_id)
    result = await session.scalars(
        select(Variant).where(Variant.suite_id == suite_id).order_by(Variant.created_at)
    )
    return list(result.all())


async def create_variant(
    session: AsyncSession, suite_id: str, data: VariantCreate, known_providers: set[str]
) -> Variant:
    await get_or_404(session, Suite, suite_id)
    _check_provider(data.provider, known_providers)
    await _ensure_name_available(session, suite_id, data.name)
    variant = Variant(suite_id=suite_id, **data.model_dump())
    session.add(variant)
    await session.commit()
    return variant


async def update_variant(
    session: AsyncSession, variant_id: str, data: VariantUpdate, known_providers: set[str]
) -> Variant:
    variant = await get_or_404(session, Variant, variant_id)
    changes = data.model_dump(exclude_unset=True)
    if changes.get("provider") is not None:
        _check_provider(changes["provider"], known_providers)
    if changes.get("name") is not None:
        await _ensure_name_available(session, variant.suite_id, changes["name"], variant.id)
    for field, value in changes.items():
        # temperature may be explicitly cleared; other fields ignore nulls.
        if value is not None or field == "temperature":
            setattr(variant, field, value)
    await session.commit()
    return variant


async def delete_variant(session: AsyncSession, variant_id: str) -> None:
    variant = await get_or_404(session, Variant, variant_id)
    await session.delete(variant)
    await session.commit()
