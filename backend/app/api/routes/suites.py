from fastapi import APIRouter, status

from app.api.deps import SessionDep
from app.schemas.comparisons import BaselineUpdate
from app.schemas.suites import SuiteCreate, SuiteDetail, SuiteSummary, SuiteUpdate
from app.services import suites as service

router = APIRouter(prefix="/suites", tags=["suites"])


@router.get("", response_model=list[SuiteSummary])
async def list_suites(session: SessionDep) -> list[SuiteSummary]:
    return await service.list_suites(session)


@router.post("", response_model=SuiteDetail, status_code=status.HTTP_201_CREATED)
async def create_suite(data: SuiteCreate, session: SessionDep) -> SuiteDetail:
    suite = await service.create_suite(session, data)
    return await service.get_suite_detail(session, suite.id)


@router.get("/{suite_id}", response_model=SuiteDetail)
async def get_suite(suite_id: str, session: SessionDep) -> SuiteDetail:
    return await service.get_suite_detail(session, suite_id)


@router.patch("/{suite_id}", response_model=SuiteDetail)
async def update_suite(suite_id: str, data: SuiteUpdate, session: SessionDep) -> SuiteDetail:
    await service.update_suite(session, suite_id, data)
    return await service.get_suite_detail(session, suite_id)


@router.delete("/{suite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_suite(suite_id: str, session: SessionDep) -> None:
    await service.delete_suite(session, suite_id)


@router.put("/{suite_id}/baseline", response_model=SuiteDetail)
async def set_baseline(suite_id: str, data: BaselineUpdate, session: SessionDep) -> SuiteDetail:
    """Mark a completed run (and one of its variants) as the suite's reference point."""
    await service.set_baseline(session, suite_id, data.run_id, data.run_variant_id)
    return await service.get_suite_detail(session, suite_id)


@router.delete("/{suite_id}/baseline", response_model=SuiteDetail)
async def clear_baseline(suite_id: str, session: SessionDep) -> SuiteDetail:
    await service.clear_baseline(session, suite_id)
    return await service.get_suite_detail(session, suite_id)
