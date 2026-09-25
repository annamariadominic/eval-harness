"""Baseline + comparison workflow through the API."""

from fastapi import FastAPI
from httpx import AsyncClient

from tests.fakes import ScriptedProvider, install_providers
from tests.test_runner import Harness


async def setup_suite(h: Harness) -> tuple[str, str, str, str]:
    suite_id = await h.suite(n_cases=4, tags=[["easy"], ["easy"], ["hard"], ["hard"]])
    good = await h.variant(suite_id, "echo", "Good")
    # Fails permanently on case 3, and is otherwise identical.
    flawed = await h.variant(suite_id, "fail:question 3", "Flawed")
    exact = await h.evaluator(suite_id, "Exact", "exact_match", {})
    return suite_id, good, flawed, exact


async def test_baseline_and_regression_workflow(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id, good, _, exact = await setup_suite(h)
    # Candidate variant whose template drops the question number for "hard" cases.
    worse = await client.post(
        f"/api/suites/{suite_id}/variants",
        json={"name": "Worse", "provider": "scripted", "model": "echo",
              "user_template": "{{ q }}!"},
    )  # fmt: skip

    baseline_run = await h.run(suite_id, variant_ids=[good], evaluator_ids=[exact])
    baseline_arm = baseline_run["variants"][0]["id"]
    response = await client.put(
        f"/api/suites/{suite_id}/baseline", json={"run_id": baseline_run["id"]}
    )
    assert response.status_code == 200, response.text
    assert response.json()["baseline"]["run_variant_id"] == baseline_arm

    candidate_run = await h.run(
        suite_id, variant_ids=[worse.json()["id"]], evaluator_ids=[exact], tags=["hard"]
    )
    candidate_arm = candidate_run["variants"][0]["id"]

    report = (
        await client.get("/api/compare", params={"base": baseline_arm, "target": candidate_arm})
    ).json()
    assert report["base"]["is_baseline"] is True
    assert report["coverage"] == {"shared": 2, "base_only": 2, "target_only": 0}
    assert report["counts"] == {"improved": 0, "regressed": 2, "unchanged": 0, "incomparable": 0}
    assert report["base_metrics"]["overall_score"] == 1.0
    assert report["target_metrics"]["overall_score"] == 0.0
    assert report["overall_delta"] == -1.0
    [case] = [c for c in report["cases"] if c["key"] == "c2"]
    assert case["evaluators"][0]["change"] == "regressed"
    assert [s["tag"] for s in report["slices"]] == ["hard"]
    assert report["evaluators"][0]["scoring"] == "binary"

    by_evaluator = (
        await client.get(
            "/api/compare",
            params={
                "base": baseline_arm,
                "target": candidate_arm,
                "slice_evaluator": report["evaluators"][0]["key"],
            },
        )
    ).json()
    assert by_evaluator["slice_evaluator"] == report["evaluators"][0]["key"]
    assert by_evaluator["slices"][0]["delta"] == -1.0

    inspect = await client.get(
        "/api/case-results",
        params={"test_case_id": case["test_case_id"], "arms": [baseline_arm, candidate_arm]},
    )
    body = inspect.json()
    assert body["case"]["input"] == {"q": "question 2"}
    assert [a["arm"]["variant_name"] for a in body["arms"]] == ["Good", "Worse"]
    assert body["arms"][1]["output"] == "question 2!"
    assert body["arms"][1]["scores"][0]["reason"].startswith("Expected")

    suites = (await client.get("/api/suites")).json()
    assert suites[0]["baseline"]["overall_score"] == 1.0
    assert suites[0]["delta_vs_baseline"] == -1.0

    runs = (await client.get(f"/api/suites/{suite_id}/runs")).json()
    assert {r["id"]: r["is_baseline"] for r in runs} == {
        baseline_run["id"]: True,
        candidate_run["id"]: False,
    }

    # Deleting the baseline run clears the suite's baseline.
    await client.delete(f"/api/runs/{baseline_run['id']}")
    assert (await client.get(f"/api/suites/{suite_id}")).json()["baseline"] is None


async def test_single_arm_report_and_validation(app: FastAPI, client: AsyncClient) -> None:
    install_providers(app, scripted=ScriptedProvider())
    h = Harness(app, client)
    suite_id, good, flawed, exact = await setup_suite(h)
    run = await h.run(suite_id, variant_ids=[good, flawed], evaluator_ids=[exact])
    arm_good, arm_flawed = (v["id"] for v in run["variants"])

    single = (await client.get("/api/compare", params={"target": arm_flawed})).json()
    assert single["base"] is None and single["counts"] is None
    assert single["target_metrics"]["failed"] == 1
    assert {s["tag"] for s in single["slices"]} == {"easy", "hard"}

    within_run = (
        await client.get("/api/compare", params={"base": arm_good, "target": arm_flawed})
    ).json()
    assert within_run["counts"]["incomparable"] == 1
    failed_case = next(c for c in within_run["cases"] if c["target_status"] == "failed")
    assert failed_case["target_error_type"] == "bad_request"

    ambiguous = await client.put(f"/api/suites/{suite_id}/baseline", json={"run_id": run["id"]})
    assert ambiguous.status_code == 422
    chosen = await client.put(
        f"/api/suites/{suite_id}/baseline",
        json={"run_id": run["id"], "run_variant_id": arm_good},
    )
    assert chosen.json()["baseline"]["variant_name"] == "Good"
    cleared = await client.delete(f"/api/suites/{suite_id}/baseline")
    assert cleared.json()["baseline"] is None

    other_suite = (await client.post("/api/suites", json={"name": "Other"})).json()
    foreign = await client.put(
        f"/api/suites/{other_suite['id']}/baseline", json={"run_id": run["id"]}
    )
    assert foreign.status_code == 404
    assert (await client.get("/api/compare", params={"target": "rv_missing"})).status_code == 404
