"""Make seeding reproducible, so re-exporting unchanged code yields byte-identical fixtures.

Identifiers and timestamps are normally random and wall-clock. While seeding the demo database
they come from counters instead, and runs use a single worker so items finish in a fixed order.
Stable output keeps golden-fixture diffs reviewable and the snapshot version unchanged (which
would otherwise reset every visitor's saved sandbox on each deploy).
"""

import hashlib
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta, tzinfo
from unittest.mock import patch

import app.db.base as db_base
import app.db.models as db_models

EPOCH = datetime(2026, 9, 1, 9, 0, tzinfo=UTC)
TICK = timedelta(milliseconds=7)


@contextmanager
def deterministic_ids_and_clock(epoch: datetime = EPOCH) -> Iterator[None]:
    counters: Counter[str] = Counter()
    ticks = 0

    def new_id(prefix: str) -> str:
        counters[prefix] += 1
        digest = hashlib.sha256(f"{prefix}:{counters[prefix]}".encode()).hexdigest()
        return f"{prefix}_{digest[:12]}"

    class Clock(datetime):
        @classmethod
        def now(cls, tz: tzinfo | None = None) -> "Clock":
            nonlocal ticks
            ticks += 1
            moment = epoch + TICK * ticks
            return cls.fromtimestamp(moment.timestamp(), tz)

    with patch.object(db_models, "new_id", new_id), patch.object(db_base, "datetime", Clock):
        yield
