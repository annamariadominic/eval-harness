from fastapi import APIRouter, Request, status

from app.api.deps import RegistryDep, SessionDep, SettingsDep
from app.runner.manager import RunManager
from app.schemas.runs import ResumeRequest, RunCreate, RunDetail, RunOut
from app.services import runs as service

router = APIRouter(tags=["runs"])


def _manager(request: Request) -> RunManager:
    manager: RunManager = request.app.state.run_manager
    return manager


@router.get("/runs", response_model=list[RunOut])
async def list_runs(session: SessionDep, suite_id: str | None = None) -> list[RunOut]:
    return await service.list_runs(session, suite_id)


@router.get("/suites/{suite_id}/runs", response_model=list[RunOut])
async def list_suite_runs(suite_id: str, session: SessionDep) -> list[RunOut]:
    return await service.list_runs(session, suite_id)


@router.post(
    "/suites/{suite_id}/runs", response_model=RunDetail, status_code=status.HTTP_202_ACCEPTED
)
async def create_run(
    suite_id: str,
    data: RunCreate,
    request: Request,
    session: SessionDep,
    registry: RegistryDep,
    settings: SettingsDep,
) -> RunDetail:
    """Snapshot the selected configuration and start executing it in the background."""
    run = await service.create_run(
        session,
        suite_id,
        data,
        registry=registry,
        pricing=request.app.state.pricing,
        settings=settings,
    )
    _manager(request).start(run.id)
    return await service.get_run_detail(session, run.id)


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: str, session: SessionDep) -> RunDetail:
    return await service.get_run_detail(session, run_id)


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(run_id: str, request: Request, session: SessionDep) -> None:
    await service.delete_run(session, _manager(request), run_id)


@router.post("/runs/{run_id}/cancel", response_model=RunDetail)
async def cancel_run(run_id: str, request: Request, session: SessionDep) -> RunDetail:
    await service.cancel_run(session, _manager(request), run_id)
    session.expire_all()
    return await service.get_run_detail(session, run_id)


@router.post("/runs/{run_id}/resume", response_model=RunDetail)
async def resume_run(
    run_id: str, data: ResumeRequest, request: Request, session: SessionDep
) -> RunDetail:
    await service.resume_run(session, _manager(request), run_id, retry_failed=data.retry_failed)
    return await service.get_run_detail(session, run_id)
