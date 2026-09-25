from typing import Any

from httpx import AsyncClient


async def make_suite(client: AsyncClient, name: str = "Research QA") -> dict[str, Any]:
    response = await client.post("/api/suites", json={"name": name, "description": "d"})
    assert response.status_code == 201, response.text
    return response.json()


async def test_suite_crud(client: AsyncClient) -> None:
    suite = await make_suite(client)
    assert suite["test_case_count"] == 0
    assert suite["latest_run"] is None

    listed = (await client.get("/api/suites")).json()
    assert [s["id"] for s in listed] == [suite["id"]]

    updated = await client.patch(f"/api/suites/{suite['id']}", json={"name": "Renamed"})
    assert updated.json()["name"] == "Renamed"

    assert (await client.delete(f"/api/suites/{suite['id']}")).status_code == 204
    missing = await client.get(f"/api/suites/{suite['id']}")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"


async def test_test_case_lifecycle_and_tags(client: AsyncClient) -> None:
    suite = await make_suite(client)
    base = f"/api/suites/{suite['id']}/test-cases"
    created = await client.post(
        base,
        json={
            "key": "acme",
            "input": {"question": "Revenue?", "context": "..."},
            "expected": {"answer": "$4.2 billion"},
            "tags": ["Financial", " easy ", "financial"],
        },
    )
    assert created.status_code == 201, created.text
    case = created.json()
    assert case["tags"] == ["financial", "easy"]

    duplicate = await client.post(base, json={"key": "acme", "input": "x"})
    assert duplicate.status_code == 409

    empty = await client.post(base, json={"input": ""})
    assert empty.status_code == 422

    patched = await client.patch(f"/api/test-cases/{case['id']}", json={"tags": ["hard"]})
    assert patched.json()["tags"] == ["hard"]
    assert patched.json()["expected"] == {"answer": "$4.2 billion"}

    assert len((await client.get(base, params={"tag": "hard"})).json()) == 1
    assert len((await client.get(base, params={"q": "revenue"})).json()) == 1
    assert len((await client.get(base, params={"tag": "easy"})).json()) == 0

    detail = (await client.get(f"/api/suites/{suite['id']}")).json()
    assert detail["test_case_count"] == 1
    assert detail["tag_counts"] == {"hard": 1}

    assert (await client.delete(f"/api/test-cases/{case['id']}")).status_code == 204


async def test_import_reports_every_error_and_writes_nothing(client: AsyncClient) -> None:
    suite = await make_suite(client)
    url = f"/api/suites/{suite['id']}/test-cases/import"
    result = await client.post(
        url,
        json={
            "cases": [
                {"key": "a", "input": "ok"},
                {"key": "a", "input": "dupe"},
                {"input": None},
                {"input": "x", "expect": "typo"},
                {"input": "x", "tags": "not-a-list"},
            ]
        },
    )
    body = result.json()
    assert body["valid"] is False
    assert body["created"] == 0
    problems = {(e["index"], e["field"]) for e in body["errors"]}
    assert (1, "key") in problems
    assert (2, "input") in problems
    assert (3, "expect") in problems
    assert (4, "tags") in problems
    assert (await client.get(f"/api/suites/{suite['id']}/test-cases")).json() == []


async def test_import_dry_run_append_and_replace(client: AsyncClient) -> None:
    suite = await make_suite(client)
    url = f"/api/suites/{suite['id']}/test-cases/import"
    cases = [{"input": f"q{i}", "tags": ["easy" if i % 2 else "hard"]} for i in range(4)]

    preview = (await client.post(url, json={"cases": cases, "dry_run": True})).json()
    assert preview["valid"] and preview["created"] == 0
    assert len(preview["preview"]) == 4
    assert preview["tag_counts"] == {"hard": 2, "easy": 2}

    appended = (await client.post(url, json={"cases": cases})).json()
    assert appended["created"] == 4

    replaced = (await client.post(url, json={"cases": cases[:1], "mode": "replace"})).json()
    assert (replaced["created"], replaced["replaced"]) == (1, 4)
    assert len((await client.get(f"/api/suites/{suite['id']}/test-cases")).json()) == 1


async def test_variants_validate_provider_and_expose_template_variables(
    client: AsyncClient,
) -> None:
    suite = await make_suite(client)
    url = f"/api/suites/{suite['id']}/variants"
    payload = {
        "name": "Baseline",
        "provider": "mock",
        "model": "mock-small",
        "system_prompt": "Be helpful.",
        "user_template": "Question: {{ question }}\n{{ context }}",
    }
    created = await client.post(url, json=payload)
    assert created.status_code == 201, created.text
    assert created.json()["template_variables"] == ["question", "context"]

    assert (await client.post(url, json=payload)).status_code == 409
    unknown = await client.post(url, json=payload | {"name": "X", "provider": "acme-ai"})
    assert unknown.status_code == 422
    assert "Unknown provider" in unknown.json()["error"]["message"]

    variant_id = created.json()["id"]
    patched = await client.patch(
        f"/api/variants/{variant_id}", json={"temperature": 0.3, "model": "mock-large"}
    )
    assert patched.json()["temperature"] == 0.3
    assert patched.json()["model"] == "mock-large"


async def test_evaluators_validate_config(client: AsyncClient) -> None:
    suite = await make_suite(client)
    url = f"/api/suites/{suite['id']}/evaluators"

    ok = await client.post(
        url, json={"name": "Citation", "type": "regex", "config": {"pattern": r"\[\d+\]"}}
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["config"]["should_match"] is True  # defaults are persisted

    bad = await client.post(url, json={"name": "Bad", "type": "regex", "config": {"pattern": "("}})
    assert bad.status_code == 422
    assert bad.json()["error"]["details"]

    judge = await client.post(
        url,
        json={
            "name": "Correctness",
            "type": "llm_judge",
            "config": {"provider": "nope", "model": "m", "criteria": "Correct?"},
        },
    )
    assert judge.status_code == 422

    renamed = await client.patch(
        f"/api/evaluators/{ok.json()['id']}", json={"regression_threshold": 0.2}
    )
    assert renamed.json()["regression_threshold"] == 0.2


async def test_meta_endpoints(client: AsyncClient) -> None:
    providers = (await client.get("/api/providers")).json()
    assert {p["name"]: p["configured"] for p in providers}["mock"] is True
    types = (await client.get("/api/evaluator-types")).json()
    judge = next(t for t in types if t["type"] == "llm_judge")
    assert judge["kind"] == "llm"
    assert "criteria" in judge["config_schema"]["properties"]
