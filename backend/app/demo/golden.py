"""Golden fixtures that pin the demo's TypeScript port to this Python implementation.

Two files are produced:

* **API golden** — every read endpoint the UI uses, called through the real FastAPI app against
  the exported database. The in-browser backend must return identical bodies for the snapshot.
* **Unit golden** — input/output pairs for the pure building blocks (templates, pricing, the mock
  provider, evaluators, and the analysis functions), so the port can be checked piece by piece.
"""

from dataclasses import asdict
from pathlib import Path
from typing import Any

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.analysis.comparison import compare_case, count_changes, pair_cases
from app.analysis.metrics import aggregate_arm
from app.analysis.records import CaseRecord, ScoreRecord
from app.analysis.slices import compute_slices
from app.config import Settings
from app.db.models import Run, RunVariant, Suite
from app.db.session import Database
from app.demo.compat_cases import compat_cases
from app.domain.templates import TemplateError, render_template, template_variables
from app.evaluators.base import EvaluationSample, EvaluatorError, ModelCall
from app.evaluators.judge import JUDGE_SYSTEM_PROMPT, LLMJudgeConfig, build_judge_prompt
from app.evaluators.registry import InvalidEvaluatorConfig, build_evaluator, parse_config
from app.main import create_app
from app.pricing import PricingTable
from app.providers.mock import MockProvider
from app.providers.registry import ProviderRegistry
from app.providers.types import Message, ModelConfig, ProviderError
from app.runner.model_calls import PricedModelCaller
from app.runner.retry import CallFailedError, RetryPolicy
from app.seed.loader import load_seed_definitions
from app.services.arm_records import load_arm_records

Tables = dict[str, list[dict[str, Any]]]


async def _no_sleep(_seconds: float) -> None:
    return None


def keyless_settings(database_url: str, pricing_file: Path) -> Settings:
    """Settings with no provider keys, so golden responses match what the demo can offer."""
    return Settings(
        EVAL_HARNESS_DATABASE_URL=database_url,
        EVAL_HARNESS_PRICING_FILE=pricing_file,
        EVAL_HARNESS_SEED_EXAMPLES=False,
        EVAL_HARNESS_MOCK_LATENCY_SCALE=0,
        OPENAI_API_KEY=None,
        ANTHROPIC_API_KEY=None,
        _env_file=None,
    )


# --- API golden ----------------------------------------------------------------------------


def _comparison_pairs(tables: Tables) -> list[tuple[str, str | None]]:
    """(target, base) pairs the dashboard can request: each arm alone, against the suite
    baseline, and against every other arm of its own run."""
    baselines = {s["id"]: s["baseline_run_variant_id"] for s in tables["eval_suites"]}
    run_suite = {r["id"]: r["suite_id"] for r in tables["runs"]}
    arms_by_run: dict[str, list[str]] = {}
    for variant in tables["run_variants"]:
        arms_by_run.setdefault(variant["run_id"], []).append(variant["id"])

    pairs: list[tuple[str, str | None]] = []
    for run_id, arms in arms_by_run.items():
        baseline = baselines.get(run_suite[run_id])
        for target in arms:
            bases: list[str | None] = [None]
            if baseline and baseline != target:
                bases.append(baseline)
            bases.extend(a for a in arms if a != target and a not in bases)
            pairs.extend((target, base) for base in bases)
    return pairs


def _read_paths(tables: Tables) -> list[str]:
    paths = ["/providers", "/evaluator-types", "/suites", "/runs"]
    for suite in tables["eval_suites"]:
        prefix = f"/suites/{suite['id']}"
        paths += [prefix, f"{prefix}/test-cases", f"{prefix}/variants", f"{prefix}/evaluators"]
        paths.append(f"{prefix}/runs")
    paths += [f"/test-cases/{case['id']}" for case in tables["test_cases"]]
    paths += [f"/runs/{run['id']}" for run in tables["runs"]]

    evaluator_keys: dict[str, list[str]] = {}
    for evaluator in tables["run_evaluators"]:
        key = evaluator["evaluator_id"] or f"name:{evaluator['name']}"
        evaluator_keys.setdefault(evaluator["run_id"], []).append(key)
    run_of_arm = {v["id"]: v["run_id"] for v in tables["run_variants"]}
    for target, base in _comparison_pairs(tables):
        query = f"/compare?target={target}" + (f"&base={base}" if base else "")
        paths.append(query)
        for key in evaluator_keys.get(run_of_arm[target], []):
            paths.append(f"{query}&slice_evaluator={key}")

    baselines = {s["id"]: s["baseline_run_variant_id"] for s in tables["eval_suites"]}
    run_suite = {r["id"]: r["suite_id"] for r in tables["runs"]}
    for run in tables["runs"]:
        arms = [v["id"] for v in tables["run_variants"] if v["run_id"] == run["id"]]
        baseline = baselines.get(run_suite[run["id"]])
        if baseline and baseline not in arms:
            arms.append(baseline)
        arm_query = "".join(f"&arms={arm}" for arm in arms)
        for case in tables["run_cases"]:
            if case["run_id"] == run["id"]:
                paths.append(f"/case-results?test_case_id={case['test_case_id']}{arm_query}")

    # Error envelopes the UI can run into.
    paths += [
        "/suites/suite_missing",
        "/runs/run_missing",
        "/test-cases/case_missing",
        "/compare?target=rv_missing",
    ]
    return paths


async def api_golden(settings: Settings, tables: Tables) -> list[dict[str, Any]]:
    app = create_app(settings)
    entries: list[dict[str, Any]] = []
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://golden") as client,
    ):
        for path in _read_paths(tables):
            response = await client.get(f"/api{path}")
            entries.append(
                {
                    "method": "GET",
                    "path": path,
                    "status": response.status_code,
                    "body": response.json(),
                }
            )
    return entries


# --- unit golden: templates and pricing ----------------------------------------------------


def _template_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for definition in load_seed_definitions():
        for variant in definition["variants"]:
            for case in definition["cases"]:
                cases.append({"template": variant["user_template"], "input": case["input"]})
    cases += [
        {"template": "{{input}}", "input": {"a": 1, "b": [1, 2.5, "x"], "c": None}},
        {"template": "{{ input }}", "input": "Café — naïve ☕"},
        {"template": "{{ input }}", "input": ["é", {"k": "ü"}]},
        {"template": "{{ items[1].name }}!", "input": {"items": [{"name": "a"}, {"name": "b"}]}},
        {"template": "{{ a.b }} and {{a.b}}", "input": {"a": {"b": True}}},
        {"template": "{{ n }}", "input": {"n": 3.0}},
        {"template": "{{ missing }}", "input": {"present": 1}},
        {"template": "{{ items[5] }}", "input": {"items": [1]}},
        {"template": "{{ question }}", "input": "plain string input"},
        {"template": "No placeholders {{ }} {{1bad}}", "input": {}},
    ]
    out: list[dict[str, Any]] = []
    for case in cases:
        entry = {**case, "variables": template_variables(case["template"])}
        try:
            entry["output"] = render_template(case["template"], case["input"])
        except TemplateError as exc:
            entry["error"] = str(exc)
        out.append(entry)
    return out


def _pricing_cases(pricing: PricingTable) -> list[dict[str, Any]]:
    combos = [
        ("mock", "mock-small", 1200, 80),
        ("mock", "mock-large", 1, 1),
        ("mock", "mock-large", None, 50),
        ("mock", "mock-small", None, None),
        ("anthropic", "claude-sonnet-5", 700, 150),
        ("openai", "gpt-5-mini", 345, 0),
        ("mock", "unknown-model", 10, 10),
        ("nobody", "nothing", 10, 10),
    ]
    return [
        {
            "provider": p,
            "model": m,
            "input_tokens": i,
            "output_tokens": o,
            "cost": pricing.estimate(p, m, i, o),
        }
        for p, m, i, o in combos
    ]


# --- unit golden: mock provider ------------------------------------------------------------

QA_PROMPTS = (
    "",
    "Be concise.",
    "Answer in one sentence and cite your sources.",
    "Answer using only the context provided.",
    "Use only the context. Add a citation for every claim.",
)
EXTRACTION_PROMPTS = (
    "Extract the fields as JSON.",
    "Return only JSON. Revenue must be an integer.",
    "Return raw JSON with the full number for revenue. No markdown.",
    "Give me json with company, revenue, year.",
)
MOCK_MODELS = ("mock-small", "mock-large", "custom-model")


def _messages(system: str, user: str) -> list[Message]:
    messages = [Message(role="system", content=system)] if system.strip() else []
    return [*messages, Message(role="user", content=user)]


def _mock_requests() -> list[tuple[list[Message], ModelConfig]]:
    requests: list[tuple[list[Message], ModelConfig]] = []
    for definition in load_seed_definitions():
        extraction = definition["name"] == "Structured Extraction"
        prompts = {v["system_prompt"] for v in definition["variants"]}
        prompts |= set(EXTRACTION_PROMPTS if extraction else QA_PROMPTS)
        template = definition["variants"][0]["user_template"]
        for system in sorted(prompts):
            for model in MOCK_MODELS:
                for case in definition["cases"]:
                    user = render_template(template, case["input"])
                    requests.append((_messages(system, user), ModelConfig(model=model)))
        if extraction:
            schema = definition["evaluators"][1]["config"]["json_schema"]
            for case in definition["cases"]:
                user = render_template(template, case["input"])
                config = ModelConfig(model="mock-small", response_schema=schema)
                requests.append((_messages("Extract the fields.", user), config))
    requests += [
        (_messages("", "No passages here at all."), ModelConfig(model="mock-small")),
        (_messages("Return JSON.", "Nothing to extract."), ModelConfig(model="mock-large")),
        (
            _messages("Answer.", "Question: What?\n\n[1] Alpha ran.\n[2] Beta [3] Gamma rose."),
            ModelConfig(model="mock-large"),
        ),
    ]
    return requests


def _result_dict(result: Any) -> dict[str, Any]:
    return {
        "output": result.output,
        "latency_ms": result.latency_ms,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "model": result.model,
        "provider": result.provider,
        "finish_reason": result.finish_reason,
    }


def _request_dict(messages: list[Message], config: ModelConfig) -> dict[str, Any]:
    return {
        "messages": [m.model_dump() for m in messages],
        "config": config.model_dump(),
    }


async def _mock_cases(judge_requests: list[tuple[list[Message], ModelConfig]]) -> dict[str, Any]:
    provider = MockProvider(latency_scale=0)
    single: list[dict[str, Any]] = []
    for messages, config in [*_mock_requests(), *judge_requests]:
        result = await provider.generate(messages, config)
        single.append({**_request_dict(messages, config), "result": _result_dict(result)})

    # Failure injection depends on how many times the same request was attempted, so these are
    # sequences of attempts against one provider instance.
    sequences: list[dict[str, Any]] = []
    for rate in (0.3, 0.6, 1.0):
        for question in ("What is A?", "What is B?", "What is C?"):
            flaky = MockProvider(latency_scale=0)
            messages = _messages("Cite.", f"Question: {question}\n\n[1] A is one. [2] B is two.")
            config = ModelConfig(model="mock-small", settings={"mock_failure_rate": rate})
            attempts: list[dict[str, Any]] = []
            for _ in range(4):
                try:
                    attempts.append(
                        {"result": _result_dict(await flaky.generate(messages, config))}
                    )
                except ProviderError as exc:
                    attempts.append(
                        {"error": {"message": exc.message, "kind": exc.kind, "status_code": 503}}
                    )
            sequences.append({**_request_dict(messages, config), "attempts": attempts})
    return {"single": single, "sequences": sequences}


# --- unit golden: evaluators ---------------------------------------------------------------

EDGE_EVALUATOR_CASES: list[dict[str, Any]] = [
    # exact_match
    {"type": "exact_match", "config": {}, "input": "q", "expected": "Paris", "output": " Paris "},
    {"type": "exact_match", "config": {}, "input": "q", "expected": "Paris", "output": "paris"},
    {
        "type": "exact_match",
        "config": {"case_sensitive": False},
        "input": "q",
        "expected": "Paris",
        "output": "PARIS",
    },
    {
        "type": "exact_match",
        "config": {"collapse_whitespace": False},
        "input": "q",
        "expected": "a b",
        "output": "a  b",
    },
    {
        "type": "exact_match",
        "config": {"output_path": "answer", "expected_path": "answer"},
        "input": "q",
        "expected": {"answer": 42},
        "output": '{"answer": 42}',
    },
    {
        "type": "exact_match",
        "config": {"output_path": "answer"},
        "input": "q",
        "expected": {"answer": 42},
        "output": '{"answer": 42}',
    },
    {
        "type": "exact_match",
        "config": {"output_path": "answer"},
        "input": "q",
        "expected": 42,
        "output": "not json",
    },
    {
        "type": "exact_match",
        "config": {},
        "input": "q",
        "expected": "x" * 10,
        "output": "y" * 200,
    },
    {"type": "exact_match", "config": {}, "input": "q", "expected": None, "output": "anything"},
    {
        "type": "exact_match",
        "config": {"expected_path": "nope"},
        "input": "q",
        "expected": {"a": 1},
        "output": "1",
    },
    {"type": "exact_match", "config": {}, "input": "q", "expected": "it's", "output": 'say "hi"'},
    # contains
    {
        "type": "contains",
        "config": {"values": ["Paris", "France"]},
        "input": "q",
        "expected": None,
        "output": "paris is in france",
    },
    {
        "type": "contains",
        "config": {"values": ["Paris", "Berlin"], "case_sensitive": True},
        "input": "q",
        "expected": None,
        "output": "Paris, paris",
    },
    {
        "type": "contains",
        "config": {"values": ["x", "y"], "mode": "any"},
        "input": "q",
        "expected": None,
        "output": "only y",
    },
    {
        "type": "contains",
        "config": {"values": ["x"], "mode": "any"},
        "input": "q",
        "expected": None,
        "output": "nothing",
    },
    {
        "type": "contains",
        "config": {},
        "input": "q",
        "expected": "47 vessels",
        "output": "47  vessels.",
    },
    {
        "type": "contains",
        "config": {"expected_path": "facts"},
        "input": "q",
        "expected": {"facts": ["a", 2, {"k": "v"}]},
        "output": 'a 2 {\n  "k": "v"\n}',
    },
    {"type": "contains", "config": {}, "input": "q", "expected": None, "output": "x"},
    # regex
    {
        "type": "regex",
        "config": {"pattern": r"\[\d+\]"},
        "input": "q",
        "expected": None,
        "output": "x [2].",
    },
    {
        "type": "regex",
        "config": {"pattern": r"\[\d+\]"},
        "input": "q",
        "expected": None,
        "output": "none",
    },
    {
        "type": "regex",
        "config": {"pattern": "sorry", "should_match": False, "ignore_case": True},
        "input": "q",
        "expected": None,
        "output": "Sorry!",
    },
    {
        "type": "regex",
        "config": {"pattern": "sorry", "should_match": False},
        "input": "q",
        "expected": None,
        "output": "fine",
    },
    {
        "type": "regex",
        "config": {"pattern": "^b$", "multiline": True},
        "input": "q",
        "expected": None,
        "output": "a\nb\nc",
    },
    {
        "type": "regex",
        "config": {"pattern": "a.c", "dotall": True},
        "input": "q",
        "expected": None,
        "output": "a\nc",
    },
    {
        "type": "regex",
        "config": {"pattern": "it's"},
        "input": "q",
        "expected": None,
        "output": "it's",
    },
    # json_valid
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": ' {"a": 1} '},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": ""},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": "Here: {}"},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": '{"a": 1,}'},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": "{'a': 1}"},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": '{"a" 1}'},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": '{"a": 1} x'},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": '["a", "b'},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": "[1 2]"},
    {
        "type": "json_valid",
        "config": {},
        "input": "q",
        "expected": None,
        "output": '{\n  "a": tru\n}',
    },
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": '"bad \\q"'},
    {"type": "json_valid", "config": {}, "input": "q", "expected": None, "output": "NaN"},
    {
        "type": "json_valid",
        "config": {},
        "input": "q",
        "expected": None,
        "output": '```json\n{"a": 1}\n```',
    },
    {
        "type": "json_valid",
        "config": {"allow_code_fence": True},
        "input": "q",
        "expected": None,
        "output": 'Sure:\n```json\n{"a": 1}\n```\nDone',
    },
    {
        "type": "json_valid",
        "config": {"allow_code_fence": True},
        "input": "q",
        "expected": None,
        "output": "```\n[1, 2]```",
    },
    # json_schema
    {
        "type": "json_schema",
        "config": {"json_schema": {"type": "object", "required": ["a"]}},
        "input": "q",
        "expected": None,
        "output": '{"a": 1}',
    },
    {
        "type": "json_schema",
        "config": {"json_schema": {"type": "object", "required": ["a"]}},
        "input": "q",
        "expected": None,
        "output": "[]",
    },
    {
        "type": "json_schema",
        "config": {"json_schema": {"type": "object"}},
        "input": "q",
        "expected": None,
        "output": "oops",
    },
    # required_fields
    {
        "type": "required_fields",
        "config": {"fields": ["a", "b.c", "items[1]"]},
        "input": "q",
        "expected": None,
        "output": '{"a": 1, "b": {"c": null}, "items": [0]}',
    },
    {
        "type": "required_fields",
        "config": {"fields": ["a", "b.c"], "allow_null": True},
        "input": "q",
        "expected": None,
        "output": '{"a": 1, "b": {"c": null}}',
    },
    {
        "type": "required_fields",
        "config": {"fields": ["a"]},
        "input": "q",
        "expected": None,
        "output": "not json",
    },
    {
        "type": "required_fields",
        "config": {"fields": ["a"], "allow_code_fence": True},
        "input": "q",
        "expected": None,
        "output": '```json\n{"a": 0}\n```',
    },
    # field_match
    {
        "type": "field_match",
        "config": {"numeric_tolerance": 0.01},
        "input": "q",
        "expected": {"n": 100, "s": "Acme  Corp", "b": True, "x": None},
        "output": '{"n": 100.9, "s": "acme corp", "b": 1, "x": null}',
    },
    {
        "type": "field_match",
        "config": {},
        "input": "q",
        "expected": {"n": 0.1},
        "output": '{"n": 0.30000000000000004}',
    },
    {
        "type": "field_match",
        "config": {"case_sensitive": True, "pass_threshold": 0.5},
        "input": "q",
        "expected": {"a": "X", "b": "Y"},
        "output": '{"a": "X", "b": "y"}',
    },
    {
        "type": "field_match",
        "config": {"fields": ["a", "missing_in_output"]},
        "input": "q",
        "expected": {"a": [1, 2], "missing_in_output": 3},
        "output": '{"a": [1, 2]}',
    },
    {
        "type": "field_match",
        "config": {"fields": ["nope"]},
        "input": "q",
        "expected": {"a": 1},
        "output": '{"a": 1}',
    },
    {"type": "field_match", "config": {}, "input": "q", "expected": "text", "output": "{}"},
    {"type": "field_match", "config": {}, "input": "q", "expected": {}, "output": "{}"},
    {"type": "field_match", "config": {}, "input": "q", "expected": {"a": 1}, "output": "x"},
]

INVALID_CONFIGS: list[dict[str, Any]] = [
    {"type": "nope", "config": {}},
    {"type": "regex", "config": {}},
    {"type": "regex", "config": {"pattern": "("}},
    {"type": "contains", "config": {"values": ["a"], "mode": "some"}},
    {"type": "required_fields", "config": {"fields": []}},
    {"type": "field_match", "config": {"numeric_tolerance": -1}},
    {"type": "json_schema", "config": {"json_schema": {"type": "nonsense"}}},
    {"type": "exact_match", "config": {"unknown": True}},
    {"type": "llm_judge", "config": {"provider": "mock", "model": "m", "criteria": ""}},
    {
        "type": "llm_judge",
        "config": {
            "provider": "mock",
            "model": "m",
            "criteria": "c",
            "score_min": 5,
            "score_max": 1,
        },
    },
]


def _outcome_dict(outcome: Any) -> dict[str, Any]:
    return {
        "score": outcome.score,
        "passed": outcome.passed,
        "reason": outcome.reason,
        "details": outcome.details,
        "usage": asdict(outcome.usage) if outcome.usage is not None else None,
    }


class _RecordingCaller:
    """A model caller that also keeps every judge request, so the mock can be tested on them."""

    def __init__(self, caller: PricedModelCaller) -> None:
        self._caller = caller
        self.log: list[tuple[list[Message], ModelConfig]] = []

    async def __call__(
        self, provider: str, messages: list[Message], config: ModelConfig
    ) -> ModelCall:
        self.log.append((messages, config))
        return await self._caller(provider, messages, config)


async def _evaluate_case(case: dict[str, Any], caller: _RecordingCaller) -> dict[str, Any]:
    entry = dict(case)
    sample = EvaluationSample(input=case["input"], expected=case["expected"], output=case["output"])
    try:
        evaluator = build_evaluator(case["type"], case["config"], caller)
        entry["outcome"] = _outcome_dict(await evaluator.evaluate(sample))
    except EvaluatorError as exc:
        entry["error"] = str(exc)
    except CallFailedError as exc:
        entry["error"] = f"Judge call failed after {exc.attempts} attempt(s): {exc}"
    return entry


def _suite_samples(tables: Tables) -> dict[str, list[dict[str, Any]]]:
    """Distinct (input, expected, output) triples per suite, from every recorded result."""
    run_suite = {r["id"]: r["suite_id"] for r in tables["runs"]}
    cases = {c["id"]: c for c in tables["run_cases"]}
    samples: dict[str, list[dict[str, Any]]] = {}
    seen: set[tuple[str, str, str]] = set()
    for result in tables["results"]:
        if result["status"] != "succeeded":
            continue
        case = cases[result["run_case_id"]]
        suite_id = run_suite[result["run_id"]]
        identity = (suite_id, case["test_case_id"], result["output"])
        if identity in seen:
            continue
        seen.add(identity)
        samples.setdefault(suite_id, []).append(
            {"input": case["input"], "expected": case["expected"], "output": result["output"]}
        )
    return samples


async def _evaluator_cases(
    tables: Tables, pricing: PricingTable
) -> tuple[list[dict[str, Any]], list[tuple[list[Message], ModelConfig]]]:
    registry = ProviderRegistry({"mock": MockProvider(latency_scale=0)}, [])
    caller = _RecordingCaller(PricedModelCaller(registry, pricing, RetryPolicy(), sleep=_no_sleep))

    cases: list[dict[str, Any]] = []
    samples = _suite_samples(tables)
    for evaluator in tables["evaluators"]:
        config = evaluator["config"]
        if evaluator["type"] == "llm_judge" and config.get("provider") != "mock":
            continue  # only the mock can be re-run in the browser
        for sample in samples.get(evaluator["suite_id"], []):
            case = {"type": evaluator["type"], "config": config, **sample}
            cases.append(await _evaluate_case(case, caller))
    for case in EDGE_EVALUATOR_CASES:
        cases.append(await _evaluate_case(case, caller))

    judge_config = {
        "provider": "mock",
        "model": "mock-large",
        "criteria": "Does the response match the reference?",
        "score_min": 1,
        "score_max": 10,
        "include_input": False,
    }
    for output in ("Paris is the capital.", "It is Lyon.", ""):
        case = {
            "type": "llm_judge",
            "config": judge_config,
            "input": {"q": "Capital of France?"},
            "expected": "Paris is the capital of France.",
            "output": output,
        }
        cases.append(await _evaluate_case(case, caller))

    for invalid in INVALID_CONFIGS:
        try:
            parse_config(invalid["type"], invalid["config"])
        except InvalidEvaluatorConfig as exc:
            cases.append({**invalid, "config_error": {"message": str(exc), "errors": exc.errors}})
    return cases, caller.log


def _judge_prompt_cases() -> list[dict[str, Any]]:
    configs = [
        {"provider": "mock", "model": "m", "criteria": "  Be right.  "},
        {
            "provider": "mock",
            "model": "m",
            "criteria": "Faithful?",
            "score_min": 0.5,
            "score_max": 2.5,
            "include_expected": False,
        },
        {"provider": "mock", "model": "m", "criteria": "c", "include_input": False},
    ]
    samples = [
        EvaluationSample(input={"a": [1, "é"]}, expected="ref", output="out"),
        EvaluationSample(input="plain", expected=None, output=""),
        EvaluationSample(input=["x"], expected={"k": 1.0}, output="o"),
    ]
    cases: list[dict[str, Any]] = []
    for raw in configs:
        config = LLMJudgeConfig.model_validate(raw)
        for sample in samples:
            cases.append(
                {
                    "config": raw,
                    "input": sample.input,
                    "expected": sample.expected,
                    "output": sample.output,
                    "prompt": build_judge_prompt(config, sample),
                }
            )
    return cases


# --- unit golden: analysis -----------------------------------------------------------------


def _record_dict(record: CaseRecord) -> dict[str, Any]:
    return asdict(record)


def _analysis_case(
    base: list[CaseRecord] | None, target: list[CaseRecord], slice_evaluator: str | None
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "base": [_record_dict(r) for r in base] if base is not None else None,
        "target": [_record_dict(r) for r in target],
        "slice_evaluator": slice_evaluator,
        "target_metrics": aggregate_arm(target).as_dict(),
    }
    if base is None:
        entry["comparisons"] = [asdict(compare_case(None, c)) for c in target]
        entry["slices"] = [asdict(s) for s in compute_slices(target, evaluator_key=slice_evaluator)]
        return entry
    paired = pair_cases(base, target)
    shared_base = [b for b, _ in paired.shared]
    shared_target = [t for _, t in paired.shared]
    base_metrics = aggregate_arm(shared_base)
    target_metrics = aggregate_arm(shared_target)
    comparisons = [compare_case(b, t) for b, t in paired.shared]
    overall = (
        target_metrics.overall_score - base_metrics.overall_score
        if target_metrics.overall_score is not None and base_metrics.overall_score is not None
        else None
    )
    entry.update(
        {
            "paired": {
                "shared": [[b.test_case_id, t.test_case_id] for b, t in paired.shared],
                "base_only": [c.test_case_id for c in paired.base_only],
                "target_only": [c.test_case_id for c in paired.target_only],
            },
            "base_metrics": base_metrics.as_dict(),
            "shared_target_metrics": target_metrics.as_dict(),
            "comparisons": [asdict(c) for c in comparisons],
            "counts": asdict(count_changes(comparisons)),
            "overall_delta": overall,
            "slices": [
                asdict(s)
                for s in compute_slices(
                    shared_target,
                    shared_base,
                    comparisons,
                    overall_delta=overall,
                    evaluator_key=slice_evaluator,
                )
            ],
        }
    )
    return entry


def _synthetic_records() -> tuple[list[CaseRecord], list[CaseRecord]]:
    def score(
        key: str,
        value: float | None,
        passed: bool | None,
        status: str = "succeeded",
        threshold: float = 0.05,
        cost: float | None = None,
    ) -> ScoreRecord:
        return ScoreRecord(key, key.upper(), status, value, passed, threshold, "", cost)

    base = [
        CaseRecord("c1", "one", ("a", "b"), "succeeded", 100.0, 10, 5, 0.001, 1, None,
                   (score("x", 0.9, True), score("y", 0.5, None))),
        CaseRecord("c2", None, (), "succeeded", 300.0, 12, 6, None, 2, None,
                   (score("x", 0.2, False), score("y", 0.51, None, cost=0.002))),
        CaseRecord("c3", "three", ("b",), "failed", None, None, None, None, 3, "server_error",
                   (score("x", None, None, "skipped"), score("y", None, None, "skipped"))),
        CaseRecord("c4", "four", ("a",), "succeeded", 50.0, 1, 1, 0.0, 1, None,
                   (score("x", 1.0, True), score("y", None, None, "failed"))),
        CaseRecord("c6", "six", ("c",), "succeeded", 70.0, 3, 3, 0.1, 1, None,
                   (score("x", 0.5, True),)),
    ]  # fmt: skip
    target = [
        CaseRecord("c1", "one", ("a", "b"), "succeeded", 120.0, 11, 5, 0.002, 1, None,
                   (score("x", 0.7, False), score("y", 0.9, None))),
        CaseRecord("c2", None, (), "succeeded", 200.0, 12, 6, 0.001, 1, None,
                   (score("x", 0.24, True, threshold=0.1), score("y", 0.5, None))),
        CaseRecord("c3", "three", ("b",), "succeeded", 90.0, 4, 4, 0.003, 1, None,
                   (score("x", 0.5, True), score("y", 0.5, None))),
        CaseRecord("c4", "four", ("a",), "succeeded", 55.0, 1, 1, 0.0, 1, None,
                   (score("x", 1.0, True), score("y", 0.4, None))),
        CaseRecord("c5", "five", ("a",), "pending", None, None, None, None, 0, None, ()),
        CaseRecord("c7", "seven", ("c",), "failed", None, None, None, None, 2, "bad_request",
                   (score("x", None, None, "skipped"),)),
    ]  # fmt: skip
    return base, target


async def _analysis_cases(db: Database, tables: Tables) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    async with db.sessionmaker() as session:
        suites = (await session.scalars(select(Suite))).all()
        for suite in suites:
            baseline = suite.baseline_run_variant_id
            arms = (
                await session.scalars(
                    select(RunVariant)
                    .join(Run, RunVariant.run_id == Run.id)
                    .where(Run.suite_id == suite.id)
                    .order_by(Run.created_at, RunVariant.position)
                )
            ).all()
            base_records = await load_arm_records(session, baseline) if baseline else None
            for arm in arms:
                target = await load_arm_records(session, arm.id)
                cases.append(_analysis_case(None, target, None))
                if base_records is None or arm.id == baseline:
                    continue
                keys = [
                    e["evaluator_id"] or f"name:{e['name']}"
                    for e in tables["run_evaluators"]
                    if e["run_id"] == arm.run_id
                ]
                for key in [None, *keys]:
                    cases.append(_analysis_case(base_records, target, key))
    base, target = _synthetic_records()
    for key in (None, "x", "y", "missing"):
        cases.append(_analysis_case(base, target, key))
        cases.append(_analysis_case(None, target, key))
    cases.append(_analysis_case([], target, None))
    cases.append(_analysis_case(base, [], None))
    return cases


async def unit_golden(db: Database, tables: Tables, pricing_file: Path) -> dict[str, Any]:
    pricing = PricingTable.from_file(pricing_file)
    evaluators, judge_requests = await _evaluator_cases(tables, pricing)
    return {
        "python": compat_cases(),
        "templates": _template_cases(),
        "pricing": _pricing_cases(pricing),
        "mock": await _mock_cases(judge_requests),
        "judge_system_prompt": JUDGE_SYSTEM_PROMPT,
        "judge_prompts": _judge_prompt_cases(),
        "evaluators": evaluators,
        "analysis": await _analysis_cases(db, tables),
    }
