from datetime import datetime
from typing import Any, Literal

from pydantic import AliasChoices, Field, field_validator

from app.schemas.common import ApiModel, normalize_tags


class TestCaseFields(ApiModel):
    __test__ = False

    key: str | None = Field(
        default=None, max_length=200, description="Optional human-friendly identifier."
    )
    input: Any = Field(description="String or JSON value passed to the prompt template.")
    expected: Any = Field(default=None, description="Reference output, if evaluators need one.")
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(
        default_factory=dict, validation_alias=AliasChoices("meta", "metadata")
    )

    @field_validator("input")
    @classmethod
    def _input_present(cls, value: Any) -> Any:
        if value is None or value == "" or value == {}:
            raise ValueError("input must not be empty")
        return value

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str]) -> list[str]:
        return normalize_tags(value)

    @field_validator("key")
    @classmethod
    def _key(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None


class TestCaseCreate(TestCaseFields):
    pass


class TestCaseUpdate(ApiModel):
    key: str | None = Field(default=None, max_length=200)
    input: Any = None
    expected: Any = None
    tags: list[str] | None = None
    metadata: dict[str, Any] | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str] | None) -> list[str] | None:
        return normalize_tags(value) if value is not None else None


class TestCaseOut(TestCaseFields):
    id: str
    suite_id: str
    created_at: datetime
    updated_at: datetime


class DatasetImportRequest(ApiModel):
    cases: list[dict[str, Any]] = Field(description="Test cases in the documented import format.")
    mode: Literal["append", "replace"] = "append"
    dry_run: bool = Field(default=False, description="Validate and preview without saving.")


class ImportIssue(ApiModel):
    index: int
    field: str
    message: str


class DatasetImportResult(ApiModel):
    valid: bool
    dry_run: bool
    mode: Literal["append", "replace"]
    total: int
    created: int
    replaced: int
    errors: list[ImportIssue]
    preview: list[TestCaseCreate]
    tag_counts: dict[str, int]
