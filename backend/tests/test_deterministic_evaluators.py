import json
from typing import Any

import pytest
from pydantic import ValidationError

from app.evaluators.base import EvaluationSample, EvaluatorError
from app.evaluators.deterministic import (
    ContainsConfig,
    ContainsEvaluator,
    ExactMatchConfig,
    ExactMatchEvaluator,
    FieldMatchConfig,
    FieldMatchEvaluator,
    JsonSchemaConfig,
    JsonSchemaEvaluator,
    JsonValidConfig,
    JsonValidEvaluator,
    RegexConfig,
    RegexEvaluator,
    RequiredFieldsConfig,
    RequiredFieldsEvaluator,
)


def sample(output: str, expected: Any = None) -> EvaluationSample:
    return EvaluationSample(input={}, expected=expected, output=output)


class TestExactMatch:
    async def test_string_match_collapses_whitespace(self) -> None:
        ev = ExactMatchEvaluator(ExactMatchConfig(expected_path="answer"))
        outcome = await ev.evaluate(sample("  $4.2   billion\n", {"answer": "$4.2 billion"}))
        assert outcome.passed is True
        assert outcome.score == 1.0

    async def test_case_sensitivity(self) -> None:
        strict = ExactMatchEvaluator(ExactMatchConfig())
        loose = ExactMatchEvaluator(ExactMatchConfig(case_sensitive=False))
        assert (await strict.evaluate(sample("PARIS", "Paris"))).passed is False
        assert (await loose.evaluate(sample("PARIS", "Paris"))).passed is True

    async def test_output_path_compares_json_values(self) -> None:
        ev = ExactMatchEvaluator(ExactMatchConfig(expected_path="year", output_path="year"))
        assert (await ev.evaluate(sample('{"year": 2025}', {"year": 2025}))).passed is True
        missing = await ev.evaluate(sample("not json", {"year": 2025}))
        assert missing.passed is False
        assert "no JSON field" in missing.reason

    async def test_requires_expected(self) -> None:
        with pytest.raises(EvaluatorError):
            await ExactMatchEvaluator(ExactMatchConfig()).evaluate(sample("x", None))


class TestContains:
    async def test_all_mode_scores_fraction(self) -> None:
        ev = ContainsEvaluator(ContainsConfig(values=["revenue", "2025", "billion"]))
        outcome = await ev.evaluate(sample("Revenue in 2025 was 4.2B"))
        assert outcome.passed is False
        assert outcome.score == pytest.approx(2 / 3)
        assert outcome.details["missing"] == ["billion"]

    async def test_any_mode(self) -> None:
        ev = ContainsEvaluator(ContainsConfig(values=["foo", "bar"], mode="any"))
        assert (await ev.evaluate(sample("a bar"))).passed is True

    async def test_uses_expected_path_values(self) -> None:
        ev = ContainsEvaluator(ContainsConfig(expected_path="answer"))
        outcome = await ev.evaluate(sample("It was $4.2 Billion.", {"answer": "$4.2 billion"}))
        assert outcome.passed is True

    async def test_defaults_to_whole_expected_string(self) -> None:
        ev = ContainsEvaluator(ContainsConfig())
        assert (await ev.evaluate(sample("the answer is 42", "42"))).passed is True


class TestRegex:
    async def test_match_and_negation(self) -> None:
        cite = RegexEvaluator(RegexConfig(pattern=r"\[\d+\]"))
        assert (await cite.evaluate(sample("See [2]."))).passed is True
        assert (await cite.evaluate(sample("No citation."))).passed is False
        forbid = RegexEvaluator(
            RegexConfig(pattern="as an ai", should_match=False, ignore_case=True)
        )
        assert (await forbid.evaluate(sample("As an AI, I cannot"))).passed is False

    def test_invalid_pattern_rejected(self) -> None:
        with pytest.raises(ValidationError):
            RegexConfig(pattern="(unclosed")


class TestJson:
    async def test_valid_json(self) -> None:
        ev = JsonValidEvaluator(JsonValidConfig())
        assert (await ev.evaluate(sample('{"a": 1}'))).passed is True
        bad = await ev.evaluate(sample('{"a": 1,}'))
        assert bad.passed is False
        assert "line 1" in bad.reason

    async def test_code_fence_policy(self) -> None:
        fenced = 'Here you go:\n```json\n{"a": 1}\n```'
        assert (
            await JsonValidEvaluator(JsonValidConfig()).evaluate(sample(fenced))
        ).passed is False
        lenient = JsonValidEvaluator(JsonValidConfig(allow_code_fence=True))
        assert (await lenient.evaluate(sample(fenced))).passed is True

    async def test_schema_violations_are_reported(self) -> None:
        schema = {
            "type": "object",
            "properties": {"revenue": {"type": "integer"}, "company": {"type": "string"}},
            "required": ["company", "revenue"],
        }
        ev = JsonSchemaEvaluator(JsonSchemaConfig(json_schema=schema))
        assert (await ev.evaluate(sample('{"company": "Acme", "revenue": 5}'))).passed is True
        bad = await ev.evaluate(sample('{"company": "Acme", "revenue": "5B"}'))
        assert bad.passed is False
        assert "revenue" in bad.details["violations"][0]

    def test_invalid_schema_rejected(self) -> None:
        with pytest.raises(ValidationError):
            JsonSchemaConfig(json_schema={"type": "not-a-type"})


class TestRequiredFields:
    async def test_partial_presence(self) -> None:
        ev = RequiredFieldsEvaluator(
            RequiredFieldsConfig(fields=["company", "revenue", "meta.year"])
        )
        outcome = await ev.evaluate(sample(json.dumps({"company": "Acme", "revenue": None})))
        assert outcome.passed is False
        assert outcome.score == pytest.approx(1 / 3)
        assert outcome.details["missing"] == ["revenue", "meta.year"]

    async def test_allow_null(self) -> None:
        ev = RequiredFieldsEvaluator(RequiredFieldsConfig(fields=["a"], allow_null=True))
        assert (await ev.evaluate(sample('{"a": null}'))).passed is True


class TestFieldMatch:
    EXPECTED = {"company": "Acme Corp", "revenue": 4_200_000_000, "year": 2025}

    async def test_all_fields_match(self) -> None:
        ev = FieldMatchEvaluator(FieldMatchConfig())
        output = json.dumps({"company": "acme corp", "revenue": 4_200_000_000, "year": 2025})
        outcome = await ev.evaluate(sample(output, self.EXPECTED))
        assert outcome.passed is True
        assert outcome.score == 1.0

    async def test_numeric_tolerance_and_partial_score(self) -> None:
        output = json.dumps({"company": "Acme Corp", "revenue": 4_210_000_000, "year": "2025"})
        strict = await FieldMatchEvaluator(FieldMatchConfig()).evaluate(
            sample(output, self.EXPECTED)
        )
        assert strict.score == pytest.approx(1 / 3)
        tolerant = await FieldMatchEvaluator(
            FieldMatchConfig(numeric_tolerance=0.01, pass_threshold=0.6)
        ).evaluate(sample(output, self.EXPECTED))
        assert tolerant.score == pytest.approx(2 / 3)
        assert tolerant.passed is True
        by_field = {f["field"]: f["match"] for f in tolerant.details["fields"]}
        assert by_field == {"company": True, "revenue": True, "year": False}

    async def test_invalid_output_scores_zero(self) -> None:
        outcome = await FieldMatchEvaluator(FieldMatchConfig()).evaluate(
            sample("nope", self.EXPECTED)
        )
        assert (outcome.score, outcome.passed) == (0.0, False)
