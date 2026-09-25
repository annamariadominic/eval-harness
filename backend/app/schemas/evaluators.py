from datetime import datetime
from typing import Any

from pydantic import Field

from app.schemas.common import ApiModel


class EvaluatorFields(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    type: str
    config: dict[str, Any] = Field(default_factory=dict)
    regression_threshold: float = Field(
        default=0.05,
        ge=0,
        le=1,
        description="Score drop (0-1 scale) beyond which a case counts as regressed.",
    )


class EvaluatorCreate(EvaluatorFields):
    pass


class EvaluatorUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    config: dict[str, Any] | None = None
    regression_threshold: float | None = Field(default=None, ge=0, le=1)


class EvaluatorOut(EvaluatorFields):
    id: str
    suite_id: str
    created_at: datetime
    updated_at: datetime


class EvaluatorTypeOut(ApiModel):
    type: str
    label: str
    description: str
    kind: str
    scoring: str
    requires_expected: bool
    config_schema: dict[str, Any]
