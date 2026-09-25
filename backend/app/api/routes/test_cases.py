from typing import Any

from fastapi import APIRouter, status

from app.api.deps import SessionDep
from app.db.models import TestCase
from app.schemas.test_cases import (
    DatasetImportRequest,
    DatasetImportResult,
    TestCaseCreate,
    TestCaseOut,
    TestCaseUpdate,
)
from app.services import test_cases as service
from app.services.common import get_or_404

router = APIRouter(tags=["test cases"])


@router.get("/suites/{suite_id}/test-cases", response_model=list[TestCaseOut])
async def list_test_cases(
    suite_id: str, session: SessionDep, tag: str | None = None, q: str | None = None
) -> Any:
    return await service.list_test_cases(session, suite_id, tag=tag, search=q)


@router.post(
    "/suites/{suite_id}/test-cases",
    response_model=TestCaseOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_test_case(suite_id: str, data: TestCaseCreate, session: SessionDep) -> Any:
    return await service.create_test_case(session, suite_id, data)


@router.post("/suites/{suite_id}/test-cases/import", response_model=DatasetImportResult)
async def import_test_cases(
    suite_id: str, data: DatasetImportRequest, session: SessionDep
) -> DatasetImportResult:
    """Validate (and unless ``dry_run``, store) a batch of test cases. All-or-nothing."""
    return await service.import_test_cases(session, suite_id, data)


@router.get("/test-cases/{case_id}", response_model=TestCaseOut)
async def get_test_case(case_id: str, session: SessionDep) -> Any:
    return await get_or_404(session, TestCase, case_id)


@router.patch("/test-cases/{case_id}", response_model=TestCaseOut)
async def update_test_case(case_id: str, data: TestCaseUpdate, session: SessionDep) -> Any:
    return await service.update_test_case(session, case_id, data)


@router.delete("/test-cases/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_test_case(case_id: str, session: SessionDep) -> None:
    await service.delete_test_case(session, case_id)
