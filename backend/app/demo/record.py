"""Record the demo's real-model runs, once, on your own machine.

Usage (from ``backend/``, with OPENAI_API_KEY and ANTHROPIC_API_KEY in ``backend/.env``)::

    uv run python -m app.demo.record                # estimate, confirm, record, export
    uv run python -m app.demo.record --export-only  # re-export an existing recording

Builds a fresh database at ``backend/data/demo-recording.db`` with the seeded example suites,
adds the variants, evaluators, and runs from ``recordings.json``, prints an estimated cost and
asks for confirmation, executes the runs against the real providers, then exports the snapshot
and golden fixtures. An existing recording is never overwritten without ``--force``, because
re-recording costs money. Keys are only read from the environment and are never exported.
"""

import argparse
import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import func, select

from app.config import BACKEND_ROOT, Settings
from app.db.models import Evaluator, Result, Run, Suite, TestCase, Variant
from app.db.session import Database
from app.demo.export import FRONTEND_ROOT, export, seed_fresh_database
from app.domain.templates import TemplateError, render_template
from app.evaluators.base import EvaluationSample
from app.evaluators.judge import LLMJudgeConfig, build_judge_prompt
from app.evaluators.registry import normalize_config
from app.pricing import PricingTable
from app.providers.registry import ProviderRegistry
from app.runner.executor import RunExecutor
from app.schemas.runs import RunCreate
from app.services.runs import create_run

SPEC_PATH = Path(__file__).with_name("recordings.json")
DEFAULT_DB = BACKEND_ROOT / "data" / "demo-recording.db"
KEY_VARS = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}

# Rough output-token assumptions for the estimate (reasoning models spend hidden tokens too).
ASSUMED_OUTPUT_TOKENS = 250
ASSUMED_REASONING_OUTPUT_TOKENS = 800
ASSUMED_JUDGE_OUTPUT_TOKENS = 200


class RecordingError(RuntimeError):
    pass


@dataclass
class Estimate:
    generations: int = 0
    judge_calls: int = 0
    cost_usd: float = 0.0
    unpriced: set[str] = field(default_factory=set)

    def describe(self) -> str:
        lines = [
            f"{self.generations} generations and {self.judge_calls} judge calls",
            f"estimated cost: about ${self.cost_usd:.2f} (rough; assumes short answers)",
        ]
        if self.unpriced:
            lines.append(f"no pricing entry for: {', '.join(sorted(self.unpriced))}")
        return "\n".join(lines)


def load_spec(path: Path = SPEC_PATH) -> dict[str, Any]:
    spec: dict[str, Any] = json.loads(path.read_text())
    return spec


def required_providers(spec: dict[str, Any], seeded: dict[str, dict[str, str]]) -> set[str]:
    """Real providers that the spec's runs need, including judges. ``seeded`` maps suite name
    to {variant or evaluator name: provider} for the seeded definitions."""
    needed: set[str] = set()
    for suite in spec["suites"]:
        providers = dict(seeded.get(suite["suite"], {}))
        providers |= {v["name"]: v["provider"] for v in suite["variants"]}
        providers |= {
            e["name"]: e["config"]["provider"]
            for e in suite["evaluators"]
            if e["type"] == "llm_judge"
        }
        for run in suite["runs"]:
            for name in [*run["variants"], *run["evaluators"]]:
                if name in providers:
                    needed.add(providers[name])
    return needed - {"mock"}


def missing_keys(providers: set[str], settings: Settings) -> list[str]:
    configured = {"openai": settings.openai_api_key, "anthropic": settings.anthropic_api_key}
    return sorted(KEY_VARS[p] for p in providers if p in KEY_VARS and not configured.get(p))


async def _seeded_providers(db: Database) -> dict[str, dict[str, str]]:
    seeded: dict[str, dict[str, str]] = {}
    async with db.sessionmaker() as session:
        for suite in (await session.scalars(select(Suite))).all():
            names = seeded.setdefault(suite.name, {})
            for variant in (
                await session.scalars(select(Variant).where(Variant.suite_id == suite.id))
            ).all():
                names[variant.name] = variant.provider
            for evaluator in (
                await session.scalars(select(Evaluator).where(Evaluator.suite_id == suite.id))
            ).all():
                if evaluator.type == "llm_judge":
                    names[evaluator.name] = evaluator.config["provider"]
    return seeded


@dataclass(frozen=True)
class PlannedRun:
    suite_id: str
    name: str
    variant_ids: list[str]
    evaluator_ids: list[str]


async def apply_spec(db: Database, spec: dict[str, Any]) -> list[PlannedRun]:
    """Add the spec's variants and evaluators to the seeded suites; return the runs to execute."""
    planned: list[PlannedRun] = []
    async with db.sessionmaker() as session:
        for entry in spec["suites"]:
            suite = await session.scalar(select(Suite).where(Suite.name == entry["suite"]))
            if suite is None:
                raise RecordingError(f"No seeded suite named '{entry['suite']}'")
            session.add_all(Variant(suite_id=suite.id, **v) for v in entry["variants"])
            session.add_all(
                Evaluator(
                    suite_id=suite.id,
                    name=e["name"],
                    type=e["type"],
                    config=normalize_config(e["type"], e["config"]),
                    regression_threshold=e.get("regression_threshold", 0.05),
                )
                for e in entry["evaluators"]
            )
            await session.flush()
            variants = {
                v.name: v.id
                for v in (
                    await session.scalars(select(Variant).where(Variant.suite_id == suite.id))
                ).all()
            }
            evaluators = {
                e.name: e.id
                for e in (
                    await session.scalars(select(Evaluator).where(Evaluator.suite_id == suite.id))
                ).all()
            }
            for run in entry["runs"]:
                unknown = [n for n in run["variants"] if n not in variants] + [
                    n for n in run["evaluators"] if n not in evaluators
                ]
                if unknown:
                    raise RecordingError(f"Unknown names in '{run['name']}': {', '.join(unknown)}")
                planned.append(
                    PlannedRun(
                        suite_id=suite.id,
                        name=run["name"],
                        variant_ids=[variants[n] for n in run["variants"]],
                        evaluator_ids=[evaluators[n] for n in run["evaluators"]],
                    )
                )
        await session.commit()
    return planned


def _tokens(text: str) -> int:
    return max(1, round(len(text) / 4))


async def estimate(db: Database, planned: list[PlannedRun], pricing: PricingTable) -> Estimate:
    result = Estimate()

    def add(provider: str, model: str, input_tokens: int, output_tokens: int) -> None:
        cost = pricing.estimate(provider, model, input_tokens, output_tokens)
        if cost is None:
            result.unpriced.add(f"{provider}/{model}")
        else:
            result.cost_usd += cost

    async with db.sessionmaker() as session:
        for run in planned:
            cases = (
                await session.scalars(select(TestCase).where(TestCase.suite_id == run.suite_id))
            ).all()
            variants = [await session.get(Variant, i) for i in run.variant_ids]
            judges = [
                LLMJudgeConfig.model_validate(e.config)
                for i in run.evaluator_ids
                if (e := await session.get(Evaluator, i)) is not None and e.type == "llm_judge"
            ]
            for variant in variants:
                assert variant is not None
                reasoning = "reasoning_effort" in variant.settings
                assumed = ASSUMED_REASONING_OUTPUT_TOKENS if reasoning else ASSUMED_OUTPUT_TOKENS
                for case in cases:
                    try:
                        prompt = variant.system_prompt + render_template(
                            variant.user_template, case.input
                        )
                    except TemplateError:
                        prompt = variant.system_prompt
                    result.generations += 1
                    if variant.provider != "mock":
                        add(
                            variant.provider,
                            variant.model,
                            _tokens(prompt),
                            min(variant.max_tokens, assumed),
                        )
                    sample = EvaluationSample(
                        input=case.input, expected=case.expected, output="x" * 4 * 120
                    )
                    for judge in judges:
                        result.judge_calls += 1
                        if judge.provider != "mock":
                            add(
                                judge.provider,
                                judge.model,
                                _tokens(build_judge_prompt(judge, sample)) + 60,
                                ASSUMED_JUDGE_OUTPUT_TOKENS,
                            )
    return result


async def execute(
    db: Database,
    planned: list[PlannedRun],
    registry: ProviderRegistry,
    pricing: PricingTable,
    settings: Settings,
) -> list[str]:
    executor = RunExecutor(db.sessionmaker, registry, pricing)
    run_ids: list[str] = []
    for plan in planned:
        async with db.sessionmaker() as session:
            run = await create_run(
                session,
                plan.suite_id,
                RunCreate(
                    name=plan.name, variant_ids=plan.variant_ids, evaluator_ids=plan.evaluator_ids
                ),
                registry=registry,
                pricing=pricing,
                settings=settings,
            )
            run_ids.append(run.id)
        print(f"recording '{plan.name}' ...", flush=True)
        await executor.execute(run.id)
    return run_ids


async def report(db: Database, run_ids: list[str]) -> list[str]:
    """Human-readable summary, including anything that should make you re-check the recording."""
    lines: list[str] = []
    async with db.sessionmaker() as session:
        for run_id in run_ids:
            run = await session.get(Run, run_id)
            assert run is not None
            counts = dict(
                (
                    await session.execute(
                        select(Result.status, func.count())
                        .where(Result.run_id == run_id)
                        .group_by(Result.status)
                    )
                ).all()
            )
            empty = await session.scalar(
                select(func.count())
                .select_from(Result)
                .where(Result.run_id == run_id, Result.status == "succeeded", Result.output == "")
            )
            cost = await session.scalar(
                select(func.sum(Result.cost_usd)).where(Result.run_id == run_id)
            )
            lines.append(
                f"{run.name}: {run.status}, results {counts}, generation cost ${cost or 0:.4f}"
            )
            if empty:
                lines.append(f"  WARNING: {empty} generations returned empty output")
            if counts.get("failed"):
                lines.append("  WARNING: some generations failed; inspect them before publishing")
    return lines


async def record(
    *,
    spec: dict[str, Any],
    db_path: Path,
    settings: Settings,
    registry: ProviderRegistry,
    pricing: PricingTable,
    pricing_file: Path,
    confirm: Callable[[str], bool],
) -> list[str] | None:
    """Seed, plan, estimate, confirm, execute. Returns the run ids, or None if declined."""
    await seed_fresh_database(db_path, pricing_file)
    db = Database(f"sqlite+aiosqlite:///{db_path.resolve()}")
    try:
        missing = missing_keys(required_providers(spec, await _seeded_providers(db)), settings)
        if missing:
            raise RecordingError(f"Set {', '.join(missing)} in backend/.env before recording")
        planned = await apply_spec(db, spec)
        if not confirm((await estimate(db, planned, pricing)).describe()):
            return None
        run_ids = await execute(db, planned, registry, pricing, settings)
        for line in await report(db, run_ids):
            print(line)
        return run_ids
    finally:
        await db.dispose()


def _ask(summary: str) -> bool:
    print(summary)
    return input("Record now? This calls the real APIs. [y/N] ").strip().lower() == "y"


async def _main(args: argparse.Namespace) -> None:
    db_path = Path(args.db)
    pricing_file = BACKEND_ROOT / "pricing.json"
    if not args.export_only:
        if db_path.exists() and not args.force:
            raise SystemExit(
                f"{db_path} already exists. Re-export it with --export-only, or pass --force to "
                "record again (this calls the real APIs)."
            )
        settings = Settings()
        settings = settings.model_copy(update={"mock_latency_scale": 0.0})
        db_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = db_path.with_suffix(".tmp.db")
        tmp.unlink(missing_ok=True)
        run_ids = await record(
            spec=load_spec(),
            db_path=tmp,
            settings=settings,
            registry=ProviderRegistry.from_settings(settings),
            pricing=PricingTable.from_file(pricing_file),
            pricing_file=pricing_file,
            confirm=(lambda _summary: True) if args.yes else _ask,
        )
        if run_ids is None:
            tmp.unlink(missing_ok=True)
            print("Nothing recorded.")
            return
        tmp.replace(db_path)
    elif not db_path.exists():
        raise SystemExit(f"No recording at {db_path}; run without --export-only first.")
    written = await export(db_path, Path(args.frontend), pricing_file)
    for path in written.values():
        print(f"wrote {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--frontend", default=str(FRONTEND_ROOT))
    parser.add_argument("--export-only", action="store_true", help="re-export an existing db")
    parser.add_argument("--force", action="store_true", help="overwrite an existing recording")
    parser.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    asyncio.run(_main(parser.parse_args()))


if __name__ == "__main__":
    main()
