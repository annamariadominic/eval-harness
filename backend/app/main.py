"""Application factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.errors import register_error_handlers
from app.api.routes import health
from app.config import Settings, get_settings
from app.db.session import Database

API_PREFIX = "/api"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings.database_url)
        await db.create_all()
        app.state.db = db
        app.state.settings = settings
        try:
            yield
        finally:
            await db.dispose()

    app = FastAPI(
        title="Eval Harness API",
        version="0.1.0",
        description="Evaluate LLM-backed features across prompts and models.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(health.router, prefix=API_PREFIX)
    return app


app = create_app()
