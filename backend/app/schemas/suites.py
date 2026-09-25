from datetime import datetime

from pydantic import Field

from app.schemas.common import ApiModel


class SuiteCreate(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class SuiteUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None


class ArmScore(ApiModel):
    """Headline numbers for one variant within one run."""

    run_id: str
    run_name: str
    run_variant_id: str
    variant_name: str
    overall_score: float | None
    pass_rate: float | None


class LatestRun(ApiModel):
    id: str
    name: str
    status: str
    created_at: datetime
    best: ArmScore | None = None


class SuiteSummary(ApiModel):
    id: str
    name: str
    description: str
    test_case_count: int
    variant_count: int
    evaluator_count: int
    run_count: int
    latest_run: LatestRun | None
    baseline: ArmScore | None
    delta_vs_baseline: float | None
    created_at: datetime
    updated_at: datetime


class SuiteDetail(SuiteSummary):
    tag_counts: dict[str, int]
