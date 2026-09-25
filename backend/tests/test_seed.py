from pathlib import Path

from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.main import create_app
from app.seed.loader import load_seed_definitions
from app.services.test_cases import validate_import


def test_seed_cases_satisfy_the_import_schema() -> None:
    for definition in load_seed_definitions():
        parsed, issues = validate_import(definition["cases"], set())
        assert issues == []
        assert len(parsed) >= 8


async def test_seeding_populates_suites_runs_and_baselines(tmp_path: Path) -> None:
    settings = Settings(
        EVAL_HARNESS_DATABASE_URL=f"sqlite+aiosqlite:///{tmp_path / 'seed.db'}",
        EVAL_HARNESS_SEED_EXAMPLES=True,
        EVAL_HARNESS_MOCK_LATENCY_SCALE=0,
        OPENAI_API_KEY=None,
        ANTHROPIC_API_KEY=None,
        _env_file=None,
    )
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client,
    ):
        suites = (await client.get("/api/suites")).json()
        assert [s["name"] for s in suites] == ["Research QA", "Structured Extraction"]
        for suite in suites:
            assert suite["run_count"] == 2
            assert suite["baseline"] is not None
            assert suite["latest_run"]["status"] == "completed"
            assert suite["delta_vs_baseline"] is not None
        runs = (await client.get("/api/runs")).json()
        assert all(r["progress"]["pending"] == 0 for r in runs)

    # Restarting against the same database must not seed twice, and history survives.
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as client,
    ):
        assert len((await client.get("/api/suites")).json()) == 2
        assert len((await client.get("/api/runs")).json()) == 4
