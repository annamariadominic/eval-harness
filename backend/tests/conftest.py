from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        EVAL_HARNESS_DATABASE_URL=f"sqlite+aiosqlite:///{tmp_path / 'test.db'}",
        EVAL_HARNESS_SEED_EXAMPLES=False,
        OPENAI_API_KEY=None,
        ANTHROPIC_API_KEY=None,
        _env_file=None,
    )


@pytest.fixture
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
