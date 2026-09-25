from typing import Any

from fastapi import APIRouter, status

from app.api.deps import RegistryDep, SessionDep
from app.schemas.evaluators import EvaluatorCreate, EvaluatorOut, EvaluatorUpdate
from app.services import evaluators as service

router = APIRouter(tags=["evaluators"])


@router.get("/suites/{suite_id}/evaluators", response_model=list[EvaluatorOut])
async def list_evaluators(suite_id: str, session: SessionDep) -> Any:
    return await service.list_evaluators(session, suite_id)


@router.post(
    "/suites/{suite_id}/evaluators",
    response_model=EvaluatorOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_evaluator(
    suite_id: str, data: EvaluatorCreate, session: SessionDep, registry: RegistryDep
) -> Any:
    return await service.create_evaluator(session, suite_id, data, registry.known_names())


@router.patch("/evaluators/{evaluator_id}", response_model=EvaluatorOut)
async def update_evaluator(
    evaluator_id: str, data: EvaluatorUpdate, session: SessionDep, registry: RegistryDep
) -> Any:
    return await service.update_evaluator(session, evaluator_id, data, registry.known_names())


@router.delete("/evaluators/{evaluator_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_evaluator(evaluator_id: str, session: SessionDep) -> None:
    await service.delete_evaluator(session, evaluator_id)
