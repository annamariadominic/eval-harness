"""FastAPI dependencies."""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.db.session import Database


def get_database(request: Request) -> Database:
    db: Database = request.app.state.db
    return db


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


async def get_session(
    db: Annotated[Database, Depends(get_database)],
) -> AsyncIterator[AsyncSession]:
    async with db.sessionmaker() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
