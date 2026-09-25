"""Runner behaviour end to end: API -> snapshot -> executor -> persisted results."""

import asyncio
import json
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update

from app.db.models import Result, Run
from tests.fakes import ScriptedProvider, install_providers


class Harness:
    def __init__(self, app: FastAPI, client: AsyncClient) -> None:
        self.app = app
        self.client = client

    async def suite(self, n_cases: int = 4, tags: list[list[str]] | None = None) -> str:
        suite = (await self.client.post("/api/suites", json={"name": "S"})).json()
        cases = [
            {"key": f"c{i}", "input": {"q": f"question {i}"}, "expected": f"question {i}",
             "tags": (tags[i] if tags else [])}
            for i in range(n_cases)
        ]  # fmt: skip
        imported = await self.client.post(
            f"/api/suites/{suite['id']}/test-cases/import", json={"cases": cases}
        )
        assert imported.json()["created"] == n_cases
        return str(suite["id"])

    async def variant(self, suite_id: str, model: str, name: str | None = None) -> str:
        response = await self.client.post(
            f"/api/suites/{suite_id}/variants",
            json={
                "name": name or model,
                "provider": "scripted",
                "model": model,
                "user_template": "{{ q }}",
            },
        )
        assert response.status_code == 201, response.text
        return str(response.json()["id"])

    async def evaluator(self, suite_id: str, name: str, type_: str, config: dict[str, Any]) -> str:
        response = await self.client.post(
            f"/api/suites/{suite_id}/evaluators",
            json={"name": name, "type": type_, "config": config},
        )
        assert response.status_code == 201, response.text
        return str(response.json()["id"])

    async def run(self, suite_id: str, **body: Any) -> dict[str, Any]:
        response = await self.client.post(f"/api/suites/{suite_id}/runs", json=body)
        assert response.status_code == 202, response.text
        run_id = response.json()["id"]
        await self.app.state.run_manager.wait(run_id)
        return dict((await self.client.get(f"/api/runs/{run_id}")).json())

    async def results(self, run_id: str) -> list[Result]:
        async with self.app.state.db.sessionmaker() as session:
            return list(
                (await session.scalars(select(Result).where(Result.run_id == run_id))).all()
            )


async def test_full_run_persists_outputs_scores_and_summary(
    app: FastAPI, client: AsyncClient
) -> None:
    provider = ScriptedProvider()
    install_providers(app, scripted=provider)
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=3)
    a = await h.variant(suite_id, "echo", "A")
    b = await h.variant(suite_id, "echo", "B")
    exact = await h.evaluator(suite_id, "Exact", "exact_match", {})
    contains = await h.evaluator(suite_id, "Mentions 1", "contains", {"values": ["1"]})

    run = await h.run(suite_id, variant_ids=[a, b], evaluator_ids=[exact, contains])

    assert run["status"] == "completed"
    assert run["progress"] == {
        "total": 6, "pending": 0, "running": 0, "succeeded": 6, "failed": 0, "cancelled": 0
    }  # fmt: skip
    assert [v["name"] for v in run["variants"]] == ["A", "B"]
    arms = run["summary"]["arms"]
    arm = arms[run["variants"][0]["id"]]
    assert arm["succeeded"] == 3
    # exact match always passes; "contains 1" passes for 1 of 3 cases -> (1 + 1/3 ...) / 3
    assert arm["overall_score"] == 0.6666666666666666
    assert arm["input_tokens"] > 0
    assert run["execution"]["retry_policy"]["max_attempts"] == 3

    results = await h.results(run["id"])
    assert all(r.request_messages for r in results)
    assert sum(provider.calls.values()) == 6  # no duplicate requests


async def test_concurrency_is_bounded(app: FastAPI, client: AsyncClient) -> None:
    provider = ScriptedProvider(delay_s=0.02)
    install_providers(app, scripted=provider)
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=8)
    variant = await h.variant(suite_id, "echo")
    run = await h.run(suite_id, variant_ids=[variant], concurrency=3)
    assert run["status"] == "completed"
    assert provider.max_in_flight == 3


async def test_transient_failures_are_retried_and_recorded(
    app: FastAPI, client: AsyncClient
) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=2)
    variant = await h.variant(suite_id, "flaky")
    run = await h.run(suite_id, variant_ids=[variant])
    assert run["progress"]["succeeded"] == 2
    assert {r.attempts for r in await h.results(run["id"])} == {2}
    assert run["summary"]["arms"][run["variants"][0]["id"]]["retried_generations"] == 2


async def test_partial_failures_do_not_sink_the_run(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=4)
    variant = await h.variant(suite_id, "fail:question 2")
    evaluator = await h.evaluator(suite_id, "Exact", "exact_match", {})
    run = await h.run(suite_id, variant_ids=[variant], evaluator_ids=[evaluator], max_attempts=3)

    assert run["status"] == "completed"
    assert (run["progress"]["succeeded"], run["progress"]["failed"]) == (3, 1)
    failed = next(r for r in await h.results(run["id"]) if r.status == "failed")
    assert failed.error_type == "bad_request"
    assert failed.attempts == 1  # permanent errors are not retried
    arm = run["summary"]["arms"][run["variants"][0]["id"]]
    assert arm["failed"] == 1
    assert arm["overall_score"] == 1.0  # failures are excluded from quality, reported separately


async def test_evaluator_errors_are_isolated(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=2)
    variant = await h.variant(suite_id, "echo")
    # The judge "model" echoes the prompt back, which is not a valid verdict.
    judge = await h.evaluator(
        suite_id,
        "Judge",
        "llm_judge",
        {"provider": "scripted", "model": "echo", "criteria": "Correct?"},
    )
    regex = await h.evaluator(suite_id, "Has digit", "regex", {"pattern": r"\d"})
    run = await h.run(suite_id, variant_ids=[variant], evaluator_ids=[judge, regex])
    arm = run["summary"]["arms"][run["variants"][0]["id"]]
    by_name = {e["evaluator_name"]: e for e in arm["evaluators"]}
    assert by_name["Judge"]["errors"] == 2
    assert by_name["Has digit"]["mean_score"] == 1.0


async def test_template_errors_fail_the_item(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=1)
    response = await client.post(
        f"/api/suites/{suite_id}/variants",
        json={
            "name": "bad",
            "provider": "scripted",
            "model": "echo",
            "user_template": "{{ nope }}",
        },
    )
    run = await h.run(suite_id, variant_ids=[response.json()["id"]])
    [result] = await h.results(run["id"])
    assert (result.status, result.error_type) == ("failed", "template_error")


async def test_resume_only_processes_unfinished_items(app: FastAPI, client: AsyncClient) -> None:
    provider = ScriptedProvider()
    install_providers(app, scripted=provider)
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=4)
    variant = await h.variant(suite_id, "fail:question 3")
    run = await h.run(suite_id, variant_ids=[variant])
    assert provider.calls.total() == 4

    # Simulate an interruption that left two items unprocessed.
    async with app.state.db.sessionmaker() as session:
        ids = [r.id for r in (await h.results(run["id"])) if r.status == "succeeded"][:2]
        await session.execute(update(Result).where(Result.id.in_(ids)).values(status="cancelled"))
        await session.commit()

    response = await client.post(f"/api/runs/{run['id']}/resume", json={})
    assert response.status_code == 200, response.text
    await app.state.run_manager.wait(run["id"])
    assert provider.calls.total() == 6  # only the two reset items were requested again

    retry = await client.post(f"/api/runs/{run['id']}/resume", json={"retry_failed": True})
    assert retry.status_code == 200
    await app.state.run_manager.wait(run["id"])
    assert provider.calls.total() == 7

    nothing = await client.post(f"/api/runs/{run['id']}/resume", json={})
    assert nothing.status_code == 409


async def test_cancel_stops_remaining_work(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider(delay_s=0.05))
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=10)
    variant = await h.variant(suite_id, "slow")
    response = await client.post(
        f"/api/suites/{suite_id}/runs", json={"variant_ids": [variant], "concurrency": 1}
    )
    run_id = response.json()["id"]
    await asyncio.sleep(0.08)
    cancelled = (await client.post(f"/api/runs/{run_id}/cancel")).json()
    assert cancelled["status"] == "cancelled"
    assert cancelled["progress"]["cancelled"] > 0
    assert cancelled["progress"]["pending"] == 0


async def test_interrupted_runs_are_recovered(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=2)
    variant = await h.variant(suite_id, "echo")
    run = await h.run(suite_id, variant_ids=[variant])
    async with app.state.db.sessionmaker() as session:
        await session.execute(update(Run).where(Run.id == run["id"]).values(status="running"))
        await session.execute(
            update(Result).where(Result.run_id == run["id"]).values(status="running")
        )
        await session.commit()

    assert await app.state.run_manager.recover_interrupted() == 1
    detail = (await client.get(f"/api/runs/{run['id']}")).json()
    assert detail["status"] == "interrupted"
    assert detail["progress"]["pending"] == 2


async def test_run_validation(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=2, tags=[["easy"], ["hard"]])
    variant = await h.variant(suite_id, "echo")

    no_cases = await client.post(
        f"/api/suites/{suite_id}/runs", json={"variant_ids": [variant], "tags": ["missing"]}
    )
    assert no_cases.status_code == 422
    unknown = await client.post(f"/api/suites/{suite_id}/runs", json={"variant_ids": ["var_x"]})
    assert unknown.status_code == 422

    unconfigured = await client.post(
        f"/api/suites/{suite_id}/variants",
        json={"name": "claude", "provider": "anthropic", "model": "claude-sonnet-5",
              "user_template": "{{ q }}"},
    )  # fmt: skip
    blocked = await client.post(
        f"/api/suites/{suite_id}/runs", json={"variant_ids": [unconfigured.json()["id"]]}
    )
    assert blocked.status_code == 422
    assert "ANTHROPIC_API_KEY" in blocked.json()["error"]["message"]

    sliced = await h.run(suite_id, variant_ids=[variant], tags=["hard"])
    assert sliced["case_count"] == 1
    assert sliced["tags"] == ["hard"]


async def test_run_snapshot_survives_config_edits(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id = await h.suite(n_cases=1)
    variant = await h.variant(suite_id, "echo", "Original")
    run = await h.run(suite_id, variant_ids=[variant])

    await client.patch(f"/api/variants/{variant}", json={"name": "Edited", "model": "slow"})
    await client.delete(f"/api/variants/{variant}")
    detail = (await client.get(f"/api/runs/{run['id']}")).json()
    assert detail["variants"][0]["name"] == "Original"
    assert detail["variants"][0]["model"] == "echo"
    assert json.dumps(detail["summary"])  # still readable
