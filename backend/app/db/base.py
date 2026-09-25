"""Declarative base and portable column types.

Everything here is dialect-neutral except the JSON variant, which upgrades to JSONB on
Postgres so a future migration keeps indexable JSON without touching the models.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, DateTime, MetaData
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase

JsonType = JSON().with_variant(JSONB(), "postgresql")

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {
        dict[str, Any]: JsonType,
        list[str]: JsonType,
        datetime: DateTime(timezone=True),
    }


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id(prefix: str) -> str:
    """Readable, prefixed identifiers (``suite_3f9a1c2b7d4e``) make logs and URLs scannable."""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"
