"""Deterministic evaluators: pure functions of the sample, no model calls."""

import math
import re
from typing import Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.evaluators.base import EvaluationSample, EvaluatorError, EvaluatorOutcome
from app.evaluators.output import (
    JsonParseError,
    PathNotFoundError,
    parse_json_output,
    resolve_path,
    to_text,
)


class _Config(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _expected_value(sample: EvaluationSample, path: str | None) -> Any:
    if sample.expected is None:
        raise EvaluatorError("This evaluator needs an expected output, but the test case has none")
    if path is None:
        return sample.expected
    try:
        return resolve_path(sample.expected, path)
    except PathNotFoundError as exc:
        raise EvaluatorError(f"Expected output has no field '{path}'") from exc


def _normalise(text: str, *, case_sensitive: bool, collapse_whitespace: bool) -> str:
    if collapse_whitespace:
        text = " ".join(text.split())
    return text if case_sensitive else text.casefold()


# --- exact match ---------------------------------------------------------------------------


class ExactMatchConfig(_Config):
    expected_path: str | None = Field(
        default=None, description="Field of the expected output to compare against."
    )
    output_path: str | None = Field(
        default=None, description="If set, parse the output as JSON and compare this field."
    )
    case_sensitive: bool = True
    collapse_whitespace: bool = True


class ExactMatchEvaluator:
    def __init__(self, config: ExactMatchConfig) -> None:
        self.config = config

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        expected = _expected_value(sample, self.config.expected_path)
        actual: Any = sample.output
        if self.config.output_path is not None:
            try:
                actual = resolve_path(parse_json_output(sample.output), self.config.output_path)
            except (JsonParseError, PathNotFoundError):
                return EvaluatorOutcome.binary(
                    False, f"Output has no JSON field '{self.config.output_path}'"
                )

        if isinstance(expected, str) or isinstance(actual, str):
            options = {
                "case_sensitive": self.config.case_sensitive,
                "collapse_whitespace": self.config.collapse_whitespace,
            }
            matched = _normalise(to_text(actual), **options) == _normalise(
                to_text(expected), **options
            )
        else:
            matched = actual == expected
        if matched:
            return EvaluatorOutcome.binary(True, "Output exactly matches the expected value")
        return EvaluatorOutcome.binary(
            False,
            f"Expected {to_text(expected)!r} but got {_truncate(to_text(actual))!r}",
        )


# --- contains ------------------------------------------------------------------------------


class ContainsConfig(_Config):
    values: list[str] = Field(default_factory=list, description="Fixed substrings to look for.")
    expected_path: str | None = Field(
        default=None,
        description="Also look for the value(s) at this field of the expected output.",
    )
    mode: Literal["all", "any"] = "all"
    case_sensitive: bool = False


class ContainsEvaluator:
    def __init__(self, config: ContainsConfig) -> None:
        self.config = config

    def _needles(self, sample: EvaluationSample) -> list[str]:
        needles = list(self.config.values)
        if self.config.expected_path is not None or (not needles and sample.expected is not None):
            expected = _expected_value(sample, self.config.expected_path)
            items = expected if isinstance(expected, list) else [expected]
            needles.extend(to_text(item) for item in items)
        if not needles:
            raise EvaluatorError("No values configured and no expected output to search for")
        return needles

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        needles = self._needles(sample)
        haystack = _normalise(
            sample.output, case_sensitive=self.config.case_sensitive, collapse_whitespace=True
        )
        found = [
            n
            for n in needles
            if _normalise(n, case_sensitive=self.config.case_sensitive, collapse_whitespace=True)
            in haystack
        ]
        missing = [n for n in needles if n not in found]
        if self.config.mode == "any":
            passed = bool(found)
            score = 1.0 if passed else 0.0
        else:
            passed = not missing
            score = len(found) / len(needles)
        reason = f"Found {len(found)} of {len(needles)} expected values" + (
            f"; missing {', '.join(repr(m) for m in missing[:5])}" if missing else ""
        )
        return EvaluatorOutcome(
            score=score, passed=passed, reason=reason, details={"found": found, "missing": missing}
        )


# --- regex ---------------------------------------------------------------------------------


class RegexConfig(_Config):
    pattern: str
    should_match: bool = True
    ignore_case: bool = False
    multiline: bool = False
    dotall: bool = False

    @field_validator("pattern")
    @classmethod
    def _compiles(cls, value: str) -> str:
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"Invalid regular expression: {exc}") from exc
        return value


class RegexEvaluator:
    def __init__(self, config: RegexConfig) -> None:
        self.config = config
        flags = (
            (re.IGNORECASE if config.ignore_case else 0)
            | (re.MULTILINE if config.multiline else 0)
            | (re.DOTALL if config.dotall else 0)
        )
        self._regex = re.compile(config.pattern, flags)

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        match = self._regex.search(sample.output)
        passed = (match is not None) == self.config.should_match
        if match is not None:
            reason = f"Pattern matched {match.group(0)!r}"
        else:
            reason = "Pattern did not match"
        if not self.config.should_match:
            reason += " (expected no match)"
        return EvaluatorOutcome.binary(passed, reason, match=match.group(0) if match else None)


# --- JSON validity and schema --------------------------------------------------------------


class JsonValidConfig(_Config):
    allow_code_fence: bool = Field(
        default=False, description="Accept JSON wrapped in a markdown ```json fence."
    )


class JsonValidEvaluator:
    def __init__(self, config: JsonValidConfig) -> None:
        self.config = config

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        try:
            parse_json_output(sample.output, allow_code_fence=self.config.allow_code_fence)
        except JsonParseError as exc:
            return EvaluatorOutcome.binary(False, str(exc))
        return EvaluatorOutcome.binary(True, "Output is valid JSON")


class JsonSchemaConfig(_Config):
    json_schema: dict[str, Any] = Field(description="JSON Schema (draft 2020-12).")
    allow_code_fence: bool = False

    @field_validator("json_schema")
    @classmethod
    def _valid_schema(cls, value: dict[str, Any]) -> dict[str, Any]:
        try:
            Draft202012Validator.check_schema(value)
        except SchemaError as exc:
            raise ValueError(f"Invalid JSON Schema: {exc.message}") from exc
        return value


class JsonSchemaEvaluator:
    def __init__(self, config: JsonSchemaConfig) -> None:
        self.config = config
        self._validator = Draft202012Validator(config.json_schema)

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        try:
            value = parse_json_output(sample.output, allow_code_fence=self.config.allow_code_fence)
        except JsonParseError as exc:
            return EvaluatorOutcome.binary(False, str(exc))
        errors = sorted(self._validator.iter_errors(value), key=lambda e: list(e.path))
        if not errors:
            return EvaluatorOutcome.binary(True, "Output conforms to the schema")
        messages = [
            f"{'/'.join(str(p) for p in e.path) or '(root)'}: {e.message}" for e in errors[:10]
        ]
        return EvaluatorOutcome.binary(
            False,
            f"{len(errors)} schema violation(s): {messages[0]}",
            violations=messages,
        )


# --- required fields -----------------------------------------------------------------------


class RequiredFieldsConfig(_Config):
    fields: list[str] = Field(min_length=1, description="Dotted paths that must be present.")
    allow_null: bool = False
    allow_code_fence: bool = False


class RequiredFieldsEvaluator:
    def __init__(self, config: RequiredFieldsConfig) -> None:
        self.config = config

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        try:
            value = parse_json_output(sample.output, allow_code_fence=self.config.allow_code_fence)
        except JsonParseError as exc:
            return EvaluatorOutcome(
                score=0.0,
                passed=False,
                reason=str(exc),
                details={"missing": self.config.fields},
            )
        missing: list[str] = []
        for path in self.config.fields:
            try:
                found = resolve_path(value, path)
            except PathNotFoundError:
                missing.append(path)
                continue
            if found is None and not self.config.allow_null:
                missing.append(path)
        present = len(self.config.fields) - len(missing)
        reason = (
            "All required fields are present"
            if not missing
            else f"Missing {len(missing)} of {len(self.config.fields)} fields: {', '.join(missing)}"
        )
        return EvaluatorOutcome(
            score=present / len(self.config.fields),
            passed=not missing,
            reason=reason,
            details={"missing": missing},
        )


# --- field-level structured comparison -----------------------------------------------------


class FieldMatchConfig(_Config):
    fields: list[str] | None = Field(
        default=None, description="Fields to compare. Defaults to every top-level expected key."
    )
    numeric_tolerance: float = Field(
        default=0.0, ge=0, description="Allowed relative difference for numbers (0.01 = 1%)."
    )
    case_sensitive: bool = False
    pass_threshold: float = Field(
        default=1.0, ge=0, le=1, description="Fraction of fields that must match to pass."
    )
    allow_code_fence: bool = False


class FieldMatchEvaluator:
    def __init__(self, config: FieldMatchConfig) -> None:
        self.config = config

    def _values_match(self, expected: Any, actual: Any) -> bool:
        if isinstance(expected, bool) or isinstance(actual, bool):
            return bool(expected == actual)
        if isinstance(expected, int | float) and isinstance(actual, int | float):
            if self.config.numeric_tolerance == 0:
                return math.isclose(expected, actual)
            return math.isclose(expected, actual, rel_tol=self.config.numeric_tolerance)
        if isinstance(expected, str) and isinstance(actual, str):
            return _normalise(
                expected, case_sensitive=self.config.case_sensitive, collapse_whitespace=True
            ) == _normalise(
                actual, case_sensitive=self.config.case_sensitive, collapse_whitespace=True
            )
        return bool(expected == actual)

    async def evaluate(self, sample: EvaluationSample) -> EvaluatorOutcome:
        expected = _expected_value(sample, None)
        fields = self.config.fields
        if fields is None:
            if not isinstance(expected, dict):
                raise EvaluatorError("Field match needs an expected JSON object or explicit fields")
            fields = list(expected.keys())
        if not fields:
            raise EvaluatorError("No fields to compare")

        try:
            actual = parse_json_output(sample.output, allow_code_fence=self.config.allow_code_fence)
        except JsonParseError as exc:
            return EvaluatorOutcome(score=0.0, passed=False, reason=str(exc), details={})

        comparisons: list[dict[str, Any]] = []
        for path in fields:
            try:
                expected_value = resolve_path(expected, path)
            except PathNotFoundError as exc:
                raise EvaluatorError(f"Expected output has no field '{path}'") from exc
            try:
                actual_value = resolve_path(actual, path)
                matched = self._values_match(expected_value, actual_value)
            except PathNotFoundError:
                actual_value, matched = None, False
            comparisons.append(
                {
                    "field": path,
                    "expected": expected_value,
                    "actual": actual_value,
                    "match": matched,
                }
            )

        matched_count = sum(1 for c in comparisons if c["match"])
        score = matched_count / len(comparisons)
        mismatched = [c["field"] for c in comparisons if not c["match"]]
        reason = (
            f"All {len(comparisons)} fields match"
            if not mismatched
            else f"{matched_count} of {len(comparisons)} fields match; "
            f"mismatched: {', '.join(mismatched)}"
        )
        return EvaluatorOutcome(
            score=score,
            passed=score >= self.config.pass_threshold,
            reason=reason,
            details={"fields": comparisons},
        )


def _truncate(text: str, limit: int = 120) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
