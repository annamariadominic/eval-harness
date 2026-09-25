"""Discovery endpoints the UI uses to build forms."""

from fastapi import APIRouter

from app.api.deps import RegistryDep
from app.evaluators.registry import EVALUATOR_TYPES
from app.schemas.evaluators import EvaluatorTypeOut
from app.schemas.meta import ProviderOut

router = APIRouter(tags=["meta"])


@router.get("/providers", response_model=list[ProviderOut])
async def list_providers(registry: RegistryDep) -> list[ProviderOut]:
    return [ProviderOut.model_validate(info) for info in registry.list_info()]


@router.get("/evaluator-types", response_model=list[EvaluatorTypeOut])
async def list_evaluator_types() -> list[EvaluatorTypeOut]:
    return [
        EvaluatorTypeOut(
            type=spec.key,
            label=spec.label,
            description=spec.description,
            kind=spec.kind,
            scoring=spec.scoring,
            requires_expected=spec.requires_expected,
            config_schema=spec.config_model.model_json_schema(),
        )
        for spec in EVALUATOR_TYPES.values()
    ]
