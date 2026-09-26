"""Dump every table of a database into one JSON-serialisable snapshot."""

import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select, text

from app.db.base import Base
from app.db.session import Database

SNAPSHOT_FORMAT = 1

# Parents before children, so a consumer can load the tables in order.
TABLES = (
    "eval_suites",
    "test_cases",
    "variants",
    "evaluators",
    "runs",
    "run_cases",
    "run_variants",
    "run_evaluators",
    "results",
    "evaluator_scores",
)


def _plain(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


async def dump_tables(db: Database) -> dict[str, list[dict[str, Any]]]:
    """Every row of every table, keyed by column name, in insertion order."""
    tables: dict[str, list[dict[str, Any]]] = {}
    async with db.engine.connect() as conn:
        for name in TABLES:
            table = Base.metadata.tables[name]
            rows = await conn.execute(select(table).order_by(text("rowid")))
            tables[name] = [
                {column: _plain(value) for column, value in row._mapping.items()} for row in rows
            ]
    return tables


def build_snapshot(tables: dict[str, list[dict[str, Any]]], pricing_file: Path) -> dict[str, Any]:
    pricing = json.loads(pricing_file.read_text()) if pricing_file.exists() else {"models": []}
    body = {"tables": tables, "pricing": pricing}
    digest = hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {"format": SNAPSHOT_FORMAT, "version": digest[:16], **body}
