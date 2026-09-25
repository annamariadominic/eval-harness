from fastapi import APIRouter, status

from app.api.deps import RegistryDep, SessionDep
from app.db.models import Variant
from app.domain.templates import template_variables
from app.schemas.variants import VariantCreate, VariantOut, VariantUpdate
from app.services import variants as service

router = APIRouter(tags=["variants"])


def _out(variant: Variant) -> VariantOut:
    out = VariantOut.model_validate(variant)
    out.template_variables = template_variables(variant.user_template)
    return out


@router.get("/suites/{suite_id}/variants", response_model=list[VariantOut])
async def list_variants(suite_id: str, session: SessionDep) -> list[VariantOut]:
    return [_out(v) for v in await service.list_variants(session, suite_id)]


@router.post(
    "/suites/{suite_id}/variants", response_model=VariantOut, status_code=status.HTTP_201_CREATED
)
async def create_variant(
    suite_id: str, data: VariantCreate, session: SessionDep, registry: RegistryDep
) -> VariantOut:
    return _out(await service.create_variant(session, suite_id, data, registry.known_names()))


@router.patch("/variants/{variant_id}", response_model=VariantOut)
async def update_variant(
    variant_id: str, data: VariantUpdate, session: SessionDep, registry: RegistryDep
) -> VariantOut:
    return _out(await service.update_variant(session, variant_id, data, registry.known_names()))


@router.delete("/variants/{variant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_variant(variant_id: str, session: SessionDep) -> None:
    await service.delete_variant(session, variant_id)
