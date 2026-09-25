"""Plain, immutable views of run results used by the analytics functions."""

from dataclasses import dataclass, field

from app.domain.statuses import ResultStatus, ScoreStatus


@dataclass(frozen=True)
class ScoreRecord:
    # Stable identity for matching the same evaluator across runs: the source evaluator id when
    # it still exists, otherwise its name.
    evaluator_key: str
    evaluator_name: str
    status: str
    score: float | None
    passed: bool | None
    regression_threshold: float = 0.05
    reason: str = ""
    cost_usd: float | None = None

    @property
    def usable(self) -> bool:
        return self.status == ScoreStatus.SUCCEEDED and self.score is not None


@dataclass(frozen=True)
class CaseRecord:
    """One test case's outcome for one variant (an "arm") in one run."""

    test_case_id: str
    key: str | None
    tags: tuple[str, ...]
    status: str
    latency_ms: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    attempts: int = 0
    error_type: str | None = None
    scores: tuple[ScoreRecord, ...] = field(default_factory=tuple)

    @property
    def succeeded(self) -> bool:
        return self.status == ResultStatus.SUCCEEDED

    @property
    def score(self) -> float | None:
        """Case-level quality: the unweighted mean of its successful evaluator scores."""
        usable = [s.score for s in self.scores if s.usable and s.score is not None]
        return sum(usable) / len(usable) if usable else None

    @property
    def passed(self) -> bool | None:
        """A case passes when every evaluator that produced a verdict passed."""
        verdicts = [s.passed for s in self.scores if s.usable and s.passed is not None]
        return all(verdicts) if verdicts else None

    def score_for(self, evaluator_key: str) -> ScoreRecord | None:
        return next((s for s in self.scores if s.evaluator_key == evaluator_key), None)
