from datetime import datetime
from typing import Any

from pydantic import Field

from app.schemas.common import ApiModel


class ArmRef(ApiModel):
    run_id: str
    run_name: str
    run_status: str
    run_created_at: datetime
    run_variant_id: str
    variant_name: str
    provider: str
    model: str
    is_baseline: bool


class EvaluatorMetricsOut(ApiModel):
    evaluator_key: str
    evaluator_name: str
    mean_score: float | None
    pass_rate: float | None
    scored: int
    errors: int


class LatencyOut(ApiModel):
    mean_ms: float | None
    p50_ms: float | None
    p95_ms: float | None


class ArmMetricsOut(ApiModel):
    total_cases: int
    succeeded: int
    failed: int
    pending: int
    scored_cases: int
    overall_score: float | None
    pass_rate: float | None
    evaluators: list[EvaluatorMetricsOut]
    latency: LatencyOut
    input_tokens: int
    output_tokens: int
    total_tokens: int
    generation_cost_usd: float | None
    judge_cost_usd: float | None
    total_cost_usd: float | None
    cost_complete: bool
    retried_generations: int


class EvaluatorDeltaOut(ApiModel):
    evaluator_key: str
    evaluator_name: str
    threshold: float
    base_score: float | None
    target_score: float | None
    base_passed: bool | None
    target_passed: bool | None
    delta: float | None
    change: str


class CaseComparisonOut(ApiModel):
    test_case_id: str
    key: str | None
    tags: list[str]
    base_status: str | None
    target_status: str | None
    base_score: float | None
    target_score: float | None
    delta: float | None
    change: str
    mixed: bool
    base_error_type: str | None
    target_error_type: str | None
    evaluators: list[EvaluatorDeltaOut]


class ChangeCountsOut(ApiModel):
    improved: int
    regressed: int
    unchanged: int
    incomparable: int


class SliceRowOut(ApiModel):
    tag: str
    cases: int
    base_score: float | None
    target_score: float | None
    delta: float | None
    base_pass_rate: float | None
    target_pass_rate: float | None
    improved: int
    regressed: int
    regressed_slice: bool
    hidden_regression: bool


class Coverage(ApiModel):
    shared: int
    base_only: int
    target_only: int


class EvaluatorRef(ApiModel):
    key: str
    name: str
    type: str
    scoring: str


class ComparisonReport(ApiModel):
    base: ArmRef | None
    target: ArmRef
    coverage: Coverage
    base_metrics: ArmMetricsOut | None
    target_metrics: ArmMetricsOut
    overall_delta: float | None
    counts: ChangeCountsOut | None
    evaluators: list[EvaluatorRef]
    cases: list[CaseComparisonOut]
    slices: list[SliceRowOut]
    slice_threshold: float
    slice_evaluator: str | None = None


class ScoreDetail(ApiModel):
    evaluator_key: str
    evaluator_name: str
    evaluator_type: str
    status: str
    score: float | None
    passed: bool | None
    reason: str
    details: dict[str, Any]
    latency_ms: float | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    error_message: str | None


class ArmResult(ApiModel):
    arm: ArmRef
    result_id: str
    status: str
    output: str | None
    request_messages: list[dict[str, Any]] | None
    response_model: str | None
    latency_ms: float | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    cost_usd: float | None
    attempts: int
    error_type: str | None
    error_message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    scores: list[ScoreDetail]


class CaseSnapshot(ApiModel):
    test_case_id: str
    key: str | None
    input: Any
    expected: Any
    tags: list[str]
    metadata: dict[str, Any] = Field(default_factory=dict)


class CaseResults(ApiModel):
    case: CaseSnapshot
    arms: list[ArmResult]


class BaselineUpdate(ApiModel):
    run_id: str
    run_variant_id: str | None = Field(
        default=None, description="Required when the run evaluated more than one variant."
    )
