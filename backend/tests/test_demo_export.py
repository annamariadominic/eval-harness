import json
from pathlib import Path

import pytest

from app.config import BACKEND_ROOT
from app.demo.export import SecretFoundError, assert_no_secrets, export, seed_fresh_database
from app.demo.snapshot import TABLES

PRICING = BACKEND_ROOT / "pricing.json"


def test_secret_scan_rejects_configured_keys_and_key_shaped_strings() -> None:
    assert_no_secrets('{"output": "fine"}', ["sk-real-key-value-123456789"])
    with pytest.raises(SecretFoundError):
        assert_no_secrets('{"x": "my-configured-secret"}', ["my-configured-secret"])
    with pytest.raises(SecretFoundError):
        assert_no_secrets('{"x": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}', [])
    with pytest.raises(SecretFoundError):
        assert_no_secrets('{"x": "sk-proj-ABCDEFGHIJKLMNOP1234"}', [])


async def test_export_writes_a_complete_deterministic_snapshot_and_golden_files(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "demo.db"
    await seed_fresh_database(db_path, PRICING)

    first = tmp_path / "first"
    second = tmp_path / "second"
    await export(db_path, first, PRICING)
    await export(db_path, second, PRICING)

    files = [
        Path("public/demo/snapshot.json"),
        Path("src/demo/__fixtures__/api-golden.json"),
        Path("src/demo/__fixtures__/unit-golden.json"),
    ]
    for relative in files:
        assert (first / relative).read_text() == (second / relative).read_text(), relative

    snapshot = json.loads((first / files[0]).read_text())
    assert snapshot["format"] == 1
    assert list(snapshot["tables"]) == list(TABLES)
    tables = snapshot["tables"]
    assert [s["name"] for s in tables["eval_suites"]] == ["Research QA", "Structured Extraction"]
    assert len(tables["runs"]) == 4
    assert all(r["status"] == "succeeded" for r in tables["results"])
    assert {m["model"] for m in snapshot["pricing"]["models"]} >= {"mock-small", "mock-large"}
    # JSON columns come through decoded, and timestamps as ISO strings.
    assert isinstance(tables["test_cases"][0]["input"], dict | str)
    assert isinstance(tables["runs"][0]["created_at"], str)

    api = json.loads((first / files[1]).read_text())
    assert api["version"] == snapshot["version"]
    by_path = {e["path"]: e for e in api["entries"]}
    providers = {p["name"]: p["configured"] for p in by_path["/providers"]["body"]}
    assert providers == {"mock": True, "openai": False, "anthropic": False}
    assert by_path["/runs/run_missing"]["status"] == 404
    assert by_path["/runs/run_missing"]["body"]["error"]["code"] == "not_found"
    compares = [e for e in api["entries"] if e["path"].startswith("/compare?")]
    assert compares and all(e["status"] == 200 for e in compares[:-1])
    assert any("slice_evaluator=" in e["path"] for e in compares)
    assert any(e["path"].startswith("/case-results?") for e in api["entries"])

    unit = json.loads((first / files[2]).read_text())
    assert {"templates", "pricing", "mock", "evaluators", "analysis"} <= set(unit)
    assert any("error" in t for t in unit["templates"])
    attempts = [a for s in unit["mock"]["sequences"] for a in s["attempts"]]
    assert any("error" in a for a in attempts) and any("result" in a for a in attempts)
    evaluator_types = {e["type"] for e in unit["evaluators"] if "outcome" in e}
    assert evaluator_types == {
        "exact_match",
        "contains",
        "regex",
        "json_valid",
        "json_schema",
        "required_fields",
        "field_match",
        "llm_judge",
    }
    assert any("config_error" in e for e in unit["evaluators"])
    assert any(case["base"] is not None for case in unit["analysis"])
