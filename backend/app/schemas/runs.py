from datetime import datetime
from typing import Any

from pydantic import Field

from app.schemas.common import ApiModel


class RunCreate(ApiModel):
    name: str | None = Field(default=None, max_length=200)
    notes: str = ""
    variant_ids: list[str] = Field(min_length=1)
    evaluator_ids: list[str] = Field(default_factory=list)
    test_case_ids: list[str] | None = Field(
        default=None, description="Explicit case selection. Defaults to every case in the suite."
    )
    tags: list[str] | None = Field(
        default=None, description="Only include cases carrying at least one of these tags."
    )
    concurrency: int | None = Field(default=None, ge=1)
    max_attempts: int = Field(default=3, ge=1, le=6)


class ResumeRequest(ApiModel):
    retry_failed: bool = Field(
        default=False, description="Also re-run generations that failed permanently."
    )


class RunVariantOut(ApiModel):
    id: str
    variant_id: str | None
    position: int
    name: str
    provider: str
    model: str
    system_prompt: str
    user_template: str
    temperature: float | None
    max_tokens: int
    settings: dict[str, Any]


class RunEvaluatorOut(ApiModel):
    id: str
    evaluator_id: str | None
    position: int
    name: str
    type: str
    config: dict[str, Any]
    regression_threshold: float


class RunProgress(ApiModel):
    total: int
    pending: int
    running: int
    succeeded: int
    failed: int
    cancelled: int

    @property
    def done(self) -> int:
        return self.succeeded + self.failed + self.cancelled


class RunOut(ApiModel):
    id: str
    suite_id: str
    suite_name: str
    name: str
    notes: str
    status: str
    concurrency: int
    max_attempts: int
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    case_count: int
    progress: RunProgress
    is_baseline: bool
    baseline_run_variant_id: str | None
    variants: list[RunVariantOut]
    evaluators: list[RunEvaluatorOut]
    summary: dict[str, Any] | None


class RunDetail(RunOut):
    execution: dict[str, Any]
    tags: list[str]
