"""Owns the background tasks that execute runs within this API process."""

import asyncio
import contextlib
import logging

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import Result, Run
from app.domain.statuses import ResultStatus, RunStatus
from app.runner.executor import RunExecutor

logger = logging.getLogger(__name__)


class RunManager:
    """In-process scheduler. A task queue (e.g. a worker service) can replace this later without
    touching the executor, because all run state lives in the database rather than in memory."""

    def __init__(
        self, sessionmaker: async_sessionmaker[AsyncSession], executor: RunExecutor
    ) -> None:
        self._sessionmaker = sessionmaker
        self._executor = executor
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def is_active(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        return task is not None and not task.done()

    def start(self, run_id: str) -> None:
        if self.is_active(run_id):
            return
        task = asyncio.create_task(self._executor.execute(run_id), name=f"run:{run_id}")
        self._tasks[run_id] = task
        task.add_done_callback(lambda t: self._on_done(run_id, t))

    def _on_done(self, run_id: str, task: asyncio.Task[None]) -> None:
        self._tasks.pop(run_id, None)
        if not task.cancelled() and task.exception() is not None:
            logger.error("Run task %s crashed", run_id, exc_info=task.exception())

    async def cancel(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        if task is None or task.done():
            return False
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        return True

    async def wait(self, run_id: str) -> None:
        task = self._tasks.get(run_id)
        if task is not None:
            await asyncio.shield(task)

    async def recover_interrupted(self) -> int:
        """Runs left active by a previous process are marked interrupted (and are resumable)."""
        async with self._sessionmaker() as session:
            stale = (
                await session.scalars(
                    select(Run.id).where(Run.status.in_([RunStatus.QUEUED, RunStatus.RUNNING]))
                )
            ).all()
            if not stale:
                return 0
            await session.execute(
                update(Result)
                .where(Result.run_id.in_(stale), Result.status == ResultStatus.RUNNING)
                .values(status=ResultStatus.PENDING)
            )
            await session.execute(
                update(Run)
                .where(Run.id.in_(stale))
                .values(
                    status=RunStatus.INTERRUPTED,
                    error="The server stopped while this run was in progress. Resume to finish it.",
                )
            )
            await session.commit()
            return len(stale)

    async def shutdown(self) -> None:
        for run_id in list(self._tasks):
            await self.cancel(run_id)
