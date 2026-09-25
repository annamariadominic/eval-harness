"""Aggregate metrics for one arm (one variant within one run).

Methodology:

* **Overall score** — mean over cases of the case score (mean of that case's evaluator scores).
  Each case counts equally regardless of how many evaluators produced a verdict.
* **Pass rate** — share of scored cases where every evaluator passed.
* Failed generations are excluded from quality averages and reported separately as errors, so a
  flaky provider shows up as an error rate instead of silently dragging quality down. Evaluator
  errors are likewise excluded from that evaluator's mean and counted as evaluator errors.
* Costs sum generation and judge spend separately; ``cost_complete`` is false when any priced
  call had no pricing entry, so totals are never presented as more certain than they are.
"""

from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

from app.analysis.records import CaseRecord
from app.domain.statuses import ResultStatus, ScoreStatus


@dataclass(frozen=True)
class EvaluatorMetrics:
    evaluator_key: str
    evaluator_name: str
    mean_score: float | None
    pass_rate: float | None
    scored: int
    errors: int


@dataclass(frozen=True)
class LatencyStats:
    mean_ms: float | None
    p50_ms: float | None
    p95_ms: float | None


@dataclass(frozen=True)
class ArmMetrics:
    total_cases: int
    succeeded: int
    failed: int
    pending: int
    scored_cases: int
    overall_score: float | None
    pass_rate: float | None
    evaluators: list[EvaluatorMetrics] = field(default_factory=list)
    latency: LatencyStats = field(default_factory=lambda: LatencyStats(None, None, None))
    input_tokens: int = 0
    output_tokens: int = 0
    generation_cost_usd: float | None = None
    judge_cost_usd: float | None = None
    cost_complete: bool = True
    retried_generations: int = 0

    @property
    def total_cost_usd(self) -> float | None:
        parts = [c for c in (self.generation_cost_usd, self.judge_cost_usd) if c is not None]
        return sum(parts) if parts else None

    def as_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["total_cost_usd"] = self.total_cost_usd
        data["total_tokens"] = self.input_tokens + self.output_tokens
        return data


def mean(values: Iterable[float]) -> float | None:
    items = list(values)
    return sum(items) / len(items) if items else None


def percentile(values: Sequence[float], pct: float) -> float | None:
    """Nearest-rank percentile; stable and easy to explain for small samples."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * pct // 100))  # ceil without floats drifting
    return ordered[int(rank) - 1]


def _sum_optional(values: Iterable[float | None]) -> tuple[float | None, bool]:
    """Sum known values; also report whether every value was known."""
    total: float | None = None
    complete = True
    for value in values:
        if value is None:
            complete = False
            continue
        total = (total or 0.0) + value
    return total, complete


def aggregate_arm(cases: Sequence[CaseRecord]) -> ArmMetrics:
    succeeded = [c for c in cases if c.succeeded]
    case_scores = [s for c in succeeded if (s := c.score) is not None]
    verdicts = [p for c in succeeded if (p := c.passed) is not None]

    evaluator_order: dict[str, str] = {}
    for case in cases:
        for score in case.scores:
            evaluator_order.setdefault(score.evaluator_key, score.evaluator_name)

    evaluators: list[EvaluatorMetrics] = []
    for key, name in evaluator_order.items():
        records = [found for c in succeeded if (found := c.score_for(key)) is not None]
        usable = [r for r in records if r.usable]
        passes = [r.passed for r in usable if r.passed is not None]
        evaluators.append(
            EvaluatorMetrics(
                evaluator_key=key,
                evaluator_name=name,
                mean_score=mean(r.score for r in usable if r.score is not None),
                pass_rate=mean(1.0 if p else 0.0 for p in passes),
                scored=len(usable),
                errors=sum(1 for r in records if r.status == ScoreStatus.FAILED),
            )
        )

    latencies = [c.latency_ms for c in succeeded if c.latency_ms is not None]
    generation_cost, generation_complete = _sum_optional(c.cost_usd for c in succeeded)
    judge_costs = [
        s.cost_usd for c in succeeded for s in c.scores if s.usable and s.cost_usd is not None
    ]
    return ArmMetrics(
        total_cases=len(cases),
        succeeded=len(succeeded),
        failed=sum(1 for c in cases if c.status == ResultStatus.FAILED),
        pending=sum(1 for c in cases if not ResultStatus(c.status).is_terminal),
        scored_cases=len(case_scores),
        overall_score=mean(case_scores),
        pass_rate=mean(1.0 if v else 0.0 for v in verdicts),
        evaluators=evaluators,
        latency=LatencyStats(
            mean_ms=mean(latencies),
            p50_ms=percentile(latencies, 50),
            p95_ms=percentile(latencies, 95),
        ),
        input_tokens=sum(c.input_tokens or 0 for c in succeeded),
        output_tokens=sum(c.output_tokens or 0 for c in succeeded),
        generation_cost_usd=generation_cost,
        judge_cost_usd=sum(judge_costs) if judge_costs else None,
        cost_complete=generation_complete,
        retried_generations=sum(1 for c in cases if c.attempts > 1),
    )
