"""Application factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.errors import register_error_handlers
from app.api.routes import evaluators, health, meta, runs, suites, test_cases, variants
from app.config import Settings, get_settings
from app.db.session import Database
from app.pricing import PricingTable
from app.providers.registry import ProviderRegistry
from app.runner.executor import RunExecutor
from app.runner.manager import RunManager

API_PREFIX = "/api"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings.database_url)
        await db.create_all()
        app.state.db = db
        app.state.settings = settings
        app.state.providers = ProviderRegistry.from_settings(settings)
        app.state.pricing = PricingTable.from_file(settings.resolved_pricing_file())
        executor = RunExecutor(db.sessionmaker, app.state.providers, app.state.pricing)
        app.state.run_manager = RunManager(db.sessionmaker, executor)
        await app.state.run_manager.recover_interrupted()
        try:
            yield
        finally:
            await app.state.run_manager.shutdown()
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
    for router in (
        health.router,
        meta.router,
        suites.router,
        test_cases.router,
        variants.router,
        evaluators.router,
        runs.router,
    ):
        app.include_router(router, prefix=API_PREFIX)
    return app


app = create_app()
