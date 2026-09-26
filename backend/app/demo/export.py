"""Export a database as the demo snapshot plus the golden fixtures for the TypeScript port.

Usage (from ``backend/``)::

    uv run python -m app.demo.export                 # freshly seeded mock-only database
    uv run python -m app.demo.export --db data/demo-recording.db

Writes ``frontend/public/demo/snapshot.json`` and ``frontend/src/demo/__fixtures__/*.json``.
Refuses to write anything that looks like an API key.
"""

import argparse
import asyncio
import json
import re
import tempfile
from pathlib import Path
from typing import Any

from app.config import BACKEND_ROOT, Settings
from app.db.session import Database
from app.demo.deterministic import deterministic_ids_and_clock
from app.demo.golden import api_golden, keyless_settings, unit_golden
from app.demo.snapshot import build_snapshot, dump_tables
from app.main import create_app

FRONTEND_ROOT = BACKEND_ROOT.parent / "frontend"
SNAPSHOT_PATH = Path("public/demo/snapshot.json")
FIXTURES_DIR = Path("src/demo/__fixtures__")

_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{16,}")


class SecretFoundError(RuntimeError):
    pass


def assert_no_secrets(text: str, secrets: list[str]) -> None:
    """Fail loudly if an export would publish a configured key or anything shaped like one."""
    for secret in secrets:
        if secret and secret in text:
            raise SecretFoundError("Export contains a configured API key; nothing was written")
    if _KEY_PATTERN.search(text):
        raise SecretFoundError("Export contains a string shaped like an API key; nothing written")


def _configured_secrets() -> list[str]:
    settings = Settings()
    return [s for s in (settings.openai_api_key, settings.anthropic_api_key) if s]


def _dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


async def seed_fresh_database(path: Path, pricing_file: Path) -> None:
    """Seed the example suites with reproducible identifiers, timestamps, and item order."""
    settings = keyless_settings(f"sqlite+aiosqlite:///{path}", pricing_file)
    settings = settings.model_copy(update={"seed_examples": True, "default_concurrency": 1})
    app = create_app(settings)
    with deterministic_ids_and_clock():
        async with app.router.lifespan_context(app):
            pass


async def export(db_path: Path, frontend_root: Path, pricing_file: Path) -> dict[str, Path]:
    url = f"sqlite+aiosqlite:///{db_path.resolve()}"
    db = Database(url)
    try:
        tables = await dump_tables(db)
        api = await api_golden(keyless_settings(url, pricing_file), tables)
        unit = await unit_golden(db, tables, pricing_file)
    finally:
        await db.dispose()

    responses = {entry["path"]: entry["body"] for entry in api}
    meta = {
        "providers": responses["/providers"],
        "evaluator_types": responses["/evaluator-types"],
    }
    snapshot = build_snapshot(tables, pricing_file, meta)

    outputs = {
        frontend_root / SNAPSHOT_PATH: _dumps(snapshot),
        frontend_root / FIXTURES_DIR / "api-golden.json": _dumps(
            {"version": snapshot["version"], "entries": api}
        ),
        frontend_root / FIXTURES_DIR / "unit-golden.json": _dumps(unit),
    }
    secrets = _configured_secrets()
    for text in outputs.values():
        assert_no_secrets(text, secrets)
    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return {path.name: path for path in outputs}


async def _main(args: argparse.Namespace) -> None:
    pricing_file = Path(args.pricing).resolve()
    if args.db:
        written = await export(Path(args.db), Path(args.frontend), pricing_file)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "demo.db"
            await seed_fresh_database(db_path, pricing_file)
            written = await export(db_path, Path(args.frontend), pricing_file)
    for path in written.values():
        print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--db", help="SQLite database to export (default: seed a fresh one)")
    parser.add_argument("--frontend", default=str(FRONTEND_ROOT), help="frontend directory")
    parser.add_argument("--pricing", default=str(BACKEND_ROOT / "pricing.json"))
    asyncio.run(_main(parser.parse_args()))


if __name__ == "__main__":
    main()
