"""Seed the example suites (and a short run history) into an empty database.

Seed runs execute through the real runner against the offline mock provider, so the dashboard
opens with genuine, reproducible results rather than hand-written fixtures.
"""

import json
import logging
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings
from app.db.models import Evaluator, Suite, TestCase, Variant
from app.evaluators.registry import normalize_config
from app.pricing import PricingTable
from app.providers.mock import MockProvider
from app.providers.registry import ProviderRegistry
from app.runner.executor import RunExecutor
from app.schemas.runs import RunCreate
from app.services.runs import create_run
from app.services.suites import set_baseline

logger = logging.getLogger(__name__)

SEED_DIR = Path(__file__).parent
SEED_FILES = ("research_qa.json", "structured_extraction.json")


def load_seed_definitions() -> list[dict[str, Any]]:
    return [json.loads((SEED_DIR / name).read_text()) for name in SEED_FILES]


async def seed_if_empty(
    sessionmaker: async_sessionmaker[AsyncSession],
    registry: ProviderRegistry,
    pricing: PricingTable,
    settings: Settings,
) -> bool:
    async with sessionmaker() as session:
        if await session.scalar(select(func.count()).select_from(Suite)):
            return False

    # Seed runs use a zero-latency mock so startup stays fast; recorded latencies are still the
    # mock's simulated values.
    seed_registry = ProviderRegistry({"mock": MockProvider(latency_scale=0)}, registry.list_info())
    executor = RunExecutor(sessionmaker, seed_registry, pricing)
    for definition in load_seed_definitions():
        await _seed_suite(sessionmaker, executor, seed_registry, pricing, settings, definition)
    logger.info("Seeded %d example suites", len(SEED_FILES))
    return True


async def _seed_suite(
    sessionmaker: async_sessionmaker[AsyncSession],
    executor: RunExecutor,
    registry: ProviderRegistry,
    pricing: PricingTable,
    settings: Settings,
    definition: dict[str, Any],
) -> None:
    async with sessionmaker() as session:
        suite = Suite(name=definition["name"], description=definition["description"])
        session.add(suite)
        await session.flush()
        session.add_all(
            TestCase(
                suite_id=suite.id,
                key=case.get("key"),
                input=case["input"],
                expected=case.get("expected"),
                tags=case.get("tags", []),
                meta=case.get("metadata", {}),
            )
            for case in definition["cases"]
        )
        variants = [Variant(suite_id=suite.id, **v) for v in definition["variants"]]
        evaluators = [
            Evaluator(
                suite_id=suite.id,
                name=e["name"],
                type=e["type"],
                config=normalize_config(e["type"], e["config"]),
                regression_threshold=e.get("regression_threshold", 0.05),
            )
            for e in definition["evaluators"]
        ]
        session.add_all([*variants, *evaluators])
        await session.commit()
        suite_id = suite.id
        variant_ids = [v.id for v in variants]
        evaluator_ids = [e.id for e in evaluators]

    for spec in definition.get("runs", []):
        async with sessionmaker() as session:
            run = await create_run(
                session,
                suite_id,
                RunCreate(
                    name=spec["name"],
                    variant_ids=[variant_ids[i] for i in spec["variants"]],
                    evaluator_ids=evaluator_ids,
                ),
                registry=registry,
                pricing=pricing,
                settings=settings,
            )
            run_id = run.id
        await executor.execute(run_id)
        if spec.get("baseline"):
            async with sessionmaker() as session:
                await set_baseline(session, suite_id, run_id, None)
