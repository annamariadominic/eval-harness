"""Engine and session lifecycle."""

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db.base import Base


def _ensure_sqlite_directory(url: str) -> None:
    prefix = "sqlite+aiosqlite:///"
    if url.startswith(prefix) and ":memory:" not in url:
        Path(url.removeprefix(prefix)).parent.mkdir(parents=True, exist_ok=True)


class Database:
    """Owns the engine and session factory for one application instance."""

    def __init__(self, url: str) -> None:
        self.url = url
        _ensure_sqlite_directory(url)
        connect_args: dict[str, Any] = {}
        if url.startswith("sqlite"):
            connect_args["timeout"] = 30
        self.engine: AsyncEngine = create_async_engine(url, connect_args=connect_args)
        if url.startswith("sqlite"):
            event.listen(self.engine.sync_engine, "connect", _configure_sqlite)
        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_all(self) -> None:
        # V1 manages schema with create_all; Alembic is the planned path once the schema
        # needs to evolve against existing user databases.
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def session(self) -> AsyncIterator[AsyncSession]:
        async with self.sessionmaker() as session:
            yield session

    async def dispose(self) -> None:
        await self.engine.dispose()


def _configure_sqlite(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()
