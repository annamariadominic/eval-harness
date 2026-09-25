"""Lifecycle states shared by persistence, the runner, and the API."""

from enum import StrEnum


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"  # process stopped mid-run; resumable

    @property
    def is_active(self) -> bool:
        return self in (RunStatus.QUEUED, RunStatus.RUNNING)


class ResultStatus(StrEnum):
    """State of one generation (one test case x one variant)."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in (ResultStatus.SUCCEEDED, ResultStatus.FAILED, ResultStatus.CANCELLED)


class ScoreStatus(StrEnum):
    """State of one evaluator applied to one generation."""

    SUCCEEDED = "succeeded"
    FAILED = "failed"  # the evaluator itself errored (e.g. judge call failed)
    SKIPPED = "skipped"  # generation failed, nothing to evaluate
