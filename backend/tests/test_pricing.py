import json
from pathlib import Path

import pytest

from app.config import BACKEND_ROOT
from app.pricing import ModelPrice, PricingTable


def test_estimate_uses_per_million_rates() -> None:
    table = PricingTable([ModelPrice("p", "m", input_per_mtok=2.0, output_per_mtok=10.0)])
    assert table.estimate("p", "m", 1_000, 500) == pytest.approx(0.002 + 0.005)


def test_unknown_model_has_no_cost() -> None:
    table = PricingTable([ModelPrice("p", "m", 1.0, 1.0)])
    assert table.estimate("p", "other", 100, 100) is None
    assert table.estimate("other", "m", 100, 100) is None


def test_missing_usage_has_no_cost() -> None:
    table = PricingTable([ModelPrice("p", "m", 1.0, 1.0)])
    assert table.estimate("p", "m", None, None) is None
    assert table.estimate("p", "m", 1_000_000, None) == pytest.approx(1.0)


def test_loads_from_file(tmp_path: Path) -> None:
    path = tmp_path / "pricing.json"
    path.write_text(
        json.dumps(
            {"models": [{"provider": "x", "model": "y", "input_per_mtok": 1, "output_per_mtok": 3}]}
        )
    )
    table = PricingTable.from_file(path)
    assert table.estimate("x", "y", 0, 1_000_000) == pytest.approx(3.0)
    assert PricingTable.from_file(tmp_path / "missing.json").lookup("x", "y") is None


def test_shipped_pricing_file_is_valid() -> None:
    table = PricingTable.from_file(BACKEND_ROOT / "pricing.json")
    assert table.lookup("mock", "mock-small") is not None
