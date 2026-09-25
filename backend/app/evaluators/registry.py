"""Registry of evaluator types.

Adding a new evaluator type means writing a config model and an evaluator class, then adding
one :class:`EvaluatorType` entry here. Nothing else in the system switches on evaluator type.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ValidationError

from app.evaluators import deterministic as det
from app.evaluators.base import Evaluator, ModelCaller
from app.evaluators.judge import LLMJudgeConfig, LLMJudgeEvaluator

Kind = Literal["deterministic", "llm"]
Scoring = Literal["binary", "fractional", "graded"]


@dataclass(frozen=True)
class EvaluatorType:
    key: str
    label: str
    description: str
    kind: Kind
    scoring: Scoring
    requires_expected: bool
    config_model: type[BaseModel]
    factory: Callable[[Any, ModelCaller | None], Evaluator]


def _deterministic(
    cls: Callable[[Any], Evaluator],
) -> Callable[[Any, ModelCaller | None], Evaluator]:
    return lambda config, _caller: cls(config)


def _judge(config: Any, caller: ModelCaller | None) -> Evaluator:
    if caller is None:
        raise ValueError("LLM judge evaluators require a model caller")
    return LLMJudgeEvaluator(config, caller)


EVALUATOR_TYPES: dict[str, EvaluatorType] = {
    t.key: t
    for t in [
        EvaluatorType(
            "exact_match",
            "Exact match",
            "Output (or a JSON field of it) equals the expected value.",
            "deterministic",
            "binary",
            True,
            det.ExactMatchConfig,
            _deterministic(det.ExactMatchEvaluator),
        ),
        EvaluatorType(
            "contains",
            "Contains",
            "Output contains fixed strings and/or values from the expected output.",
            "deterministic",
            "fractional",
            False,
            det.ContainsConfig,
            _deterministic(det.ContainsEvaluator),
        ),
        EvaluatorType(
            "regex",
            "Regex",
            "Output matches (or must not match) a regular expression.",
            "deterministic",
            "binary",
            False,
            det.RegexConfig,
            _deterministic(det.RegexEvaluator),
        ),
        EvaluatorType(
            "json_valid",
            "Valid JSON",
            "Output parses as JSON.",
            "deterministic",
            "binary",
            False,
            det.JsonValidConfig,
            _deterministic(det.JsonValidEvaluator),
        ),
        EvaluatorType(
            "json_schema",
            "JSON Schema",
            "Output is JSON that conforms to a JSON Schema.",
            "deterministic",
            "binary",
            False,
            det.JsonSchemaConfig,
            _deterministic(det.JsonSchemaEvaluator),
        ),
        EvaluatorType(
            "required_fields",
            "Required fields",
            "Output JSON contains every listed field.",
            "deterministic",
            "fractional",
            False,
            det.RequiredFieldsConfig,
            _deterministic(det.RequiredFieldsEvaluator),
        ),
        EvaluatorType(
            "field_match",
            "Field match",
            "Compares output JSON fields to the expected output, field by field.",
            "deterministic",
            "fractional",
            True,
            det.FieldMatchConfig,
            _deterministic(det.FieldMatchEvaluator),
        ),
        EvaluatorType(
            "llm_judge",
            "LLM judge",
            "A model scores the output against a custom rubric and explains why.",
            "llm",
            "graded",
            False,
            LLMJudgeConfig,
            _judge,
        ),
    ]
}


class InvalidEvaluatorConfig(ValueError):
    def __init__(self, message: str, errors: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.errors = errors or []


def get_type(type_name: str) -> EvaluatorType:
    try:
        return EVALUATOR_TYPES[type_name]
    except KeyError as exc:
        known = ", ".join(sorted(EVALUATOR_TYPES))
        raise InvalidEvaluatorConfig(
            f"Unknown evaluator type '{type_name}'. Known types: {known}"
        ) from exc


def parse_config(type_name: str, config: dict[str, Any]) -> BaseModel:
    spec = get_type(type_name)
    try:
        return spec.config_model.model_validate(config)
    except ValidationError as exc:
        errors = [{"loc": [str(p) for p in e["loc"]], "message": e["msg"]} for e in exc.errors()]
        raise InvalidEvaluatorConfig(
            f"Invalid configuration for {spec.label} evaluator", errors
        ) from exc


def normalize_config(type_name: str, config: dict[str, Any]) -> dict[str, Any]:
    """Validate and fill defaults, returning the canonical dict that gets persisted."""
    return parse_config(type_name, config).model_dump(mode="json")


def build_evaluator(
    type_name: str, config: dict[str, Any], call_model: ModelCaller | None = None
) -> Evaluator:
    return get_type(type_name).factory(parse_config(type_name, config), call_model)
