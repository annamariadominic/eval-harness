"""ORM models.

Two families of tables:

* **Editable configuration** — suites, test cases, variants, evaluators. Users change these freely.
* **Run snapshots** — ``run_cases``, ``run_variants``, ``run_evaluators`` copy the configuration at
  launch time, and ``results`` / ``evaluator_scores`` reference only the snapshots. Editing or
  deleting a variant later never changes how an old run reads.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JsonType, new_id, utcnow
from app.domain.statuses import ResultStatus, RunStatus, ScoreStatus


class Suite(Base):
    __tablename__ = "eval_suites"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("suite"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    baseline_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL", use_alter=True), default=None
    )
    baseline_run_variant_id: Mapped[str | None] = mapped_column(
        ForeignKey("run_variants.id", ondelete="SET NULL", use_alter=True), default=None
    )
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    test_cases: Mapped[list["TestCase"]] = relationship(
        back_populates="suite", cascade="all, delete-orphan", passive_deletes=True
    )
    variants: Mapped[list["Variant"]] = relationship(
        back_populates="suite", cascade="all, delete-orphan", passive_deletes=True
    )
    evaluators: Mapped[list["Evaluator"]] = relationship(
        back_populates="suite", cascade="all, delete-orphan", passive_deletes=True
    )
    runs: Mapped[list["Run"]] = relationship(
        back_populates="suite",
        cascade="all, delete-orphan",
        passive_deletes=True,
        foreign_keys="Run.suite_id",
    )


class TestCase(Base):
    __tablename__ = "test_cases"
    __test__ = False  # keep pytest from collecting this model

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("case"))
    suite_id: Mapped[str] = mapped_column(
        ForeignKey("eval_suites.id", ondelete="CASCADE"), index=True
    )
    # Optional human-friendly key ("acme-revenue-2025"); unique within a suite when set.
    key: Mapped[str | None] = mapped_column(String(200), default=None)
    input: Mapped[Any] = mapped_column(JsonType)
    expected: Mapped[Any | None] = mapped_column(JsonType, default=None)
    tags: Mapped[list[str]] = mapped_column(default=list)
    meta: Mapped[dict[str, Any]] = mapped_column("metadata", default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    suite: Mapped[Suite] = relationship(back_populates="test_cases")

    __table_args__ = (UniqueConstraint("suite_id", "key"),)


class Variant(Base):
    __tablename__ = "variants"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("var"))
    suite_id: Mapped[str] = mapped_column(
        ForeignKey("eval_suites.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(200))
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    user_template: Mapped[str] = mapped_column(Text)
    temperature: Mapped[float | None] = mapped_column(Float, default=None)
    max_tokens: Mapped[int] = mapped_column(Integer, default=1024)
    settings: Mapped[dict[str, Any]] = mapped_column(default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    suite: Mapped[Suite] = relationship(back_populates="variants")

    __table_args__ = (UniqueConstraint("suite_id", "name"),)


class Evaluator(Base):
    __tablename__ = "evaluators"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("eval"))
    suite_id: Mapped[str] = mapped_column(
        ForeignKey("eval_suites.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(50))
    config: Mapped[dict[str, Any]] = mapped_column(default=dict)
    # Minimum score drop (0-1 scale) that counts as a regression for this evaluator.
    regression_threshold: Mapped[float] = mapped_column(Float, default=0.05)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)

    suite: Mapped[Suite] = relationship(back_populates="evaluators")

    __table_args__ = (UniqueConstraint("suite_id", "name"),)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("run"))
    suite_id: Mapped[str] = mapped_column(
        ForeignKey("eval_suites.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default=RunStatus.QUEUED)
    concurrency: Mapped[int] = mapped_column(Integer, default=4)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    # Reproducibility metadata: app version, python version, retry policy, etc.
    execution: Mapped[dict[str, Any]] = mapped_column(default=dict)
    # Per-variant aggregate metrics, computed when the run finishes (cached for list views).
    summary: Mapped[dict[str, Any] | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)

    suite: Mapped[Suite] = relationship(back_populates="runs", foreign_keys=[suite_id])
    cases: Mapped[list["RunCase"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="RunCase.position",
    )
    variants: Mapped[list["RunVariant"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="RunVariant.position",
    )
    evaluators: Mapped[list["RunEvaluator"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="RunEvaluator.position",
    )


class RunCase(Base):
    """Snapshot of a test case as it was when the run launched."""

    __tablename__ = "run_cases"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("rc"))
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    # Deliberately not a foreign key: the source case may be deleted, but cross-run
    # comparisons still pair results by this identifier.
    test_case_id: Mapped[str] = mapped_column(String(32), index=True)
    position: Mapped[int] = mapped_column(Integer)
    key: Mapped[str | None] = mapped_column(String(200), default=None)
    input: Mapped[Any] = mapped_column(JsonType)
    expected: Mapped[Any | None] = mapped_column(JsonType, default=None)
    tags: Mapped[list[str]] = mapped_column(default=list)
    meta: Mapped[dict[str, Any]] = mapped_column("metadata", default=dict)

    run: Mapped[Run] = relationship(back_populates="cases")


class RunVariant(Base):
    """Snapshot of a variant's full configuration at launch time."""

    __tablename__ = "run_variants"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("rv"))
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    variant_id: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    provider: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(200))
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    user_template: Mapped[str] = mapped_column(Text)
    temperature: Mapped[float | None] = mapped_column(Float, default=None)
    max_tokens: Mapped[int] = mapped_column(Integer, default=1024)
    settings: Mapped[dict[str, Any]] = mapped_column(default=dict)

    run: Mapped[Run] = relationship(back_populates="variants")


class RunEvaluator(Base):
    """Snapshot of an evaluator's configuration at launch time."""

    __tablename__ = "run_evaluators"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("re"))
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    evaluator_id: Mapped[str | None] = mapped_column(String(32), default=None, index=True)
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    type: Mapped[str] = mapped_column(String(50))
    config: Mapped[dict[str, Any]] = mapped_column(default=dict)
    regression_threshold: Mapped[float] = mapped_column(Float, default=0.05)

    run: Mapped[Run] = relationship(back_populates="evaluators")


class Result(Base):
    """One generation: a single test case executed against a single variant."""

    __tablename__ = "results"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("res"))
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    run_case_id: Mapped[str] = mapped_column(ForeignKey("run_cases.id", ondelete="CASCADE"))
    run_variant_id: Mapped[str] = mapped_column(
        ForeignKey("run_variants.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), default=ResultStatus.PENDING)
    output: Mapped[str | None] = mapped_column(Text, default=None)
    request_messages: Mapped[list[dict[str, Any]] | None] = mapped_column(JsonType, default=None)
    response_model: Mapped[str | None] = mapped_column(String(200), default=None)
    latency_ms: Mapped[float | None] = mapped_column(Float, default=None)
    input_tokens: Mapped[int | None] = mapped_column(Integer, default=None)
    output_tokens: Mapped[int | None] = mapped_column(Integer, default=None)
    cost_usd: Mapped[float | None] = mapped_column(Float, default=None)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error_type: Mapped[str | None] = mapped_column(String(50), default=None)
    error_message: Mapped[str | None] = mapped_column(Text, default=None)
    started_at: Mapped[datetime | None] = mapped_column(default=None)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)

    case: Mapped[RunCase] = relationship()
    variant: Mapped[RunVariant] = relationship()
    scores: Mapped[list["EvaluatorScore"]] = relationship(
        back_populates="result", cascade="all, delete-orphan", passive_deletes=True
    )

    # The unique pair is what prevents a resumed run from generating the same item twice.
    __table_args__ = (UniqueConstraint("run_case_id", "run_variant_id"),)

    @property
    def total_tokens(self) -> int | None:
        if self.input_tokens is None and self.output_tokens is None:
            return None
        return (self.input_tokens or 0) + (self.output_tokens or 0)


class EvaluatorScore(Base):
    __tablename__ = "evaluator_scores"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: new_id("score"))
    result_id: Mapped[str] = mapped_column(
        ForeignKey("results.id", ondelete="CASCADE"), index=True
    )
    run_evaluator_id: Mapped[str] = mapped_column(
        ForeignKey("run_evaluators.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(String(20), default=ScoreStatus.SUCCEEDED)
    score: Mapped[float | None] = mapped_column(Float, default=None)
    passed: Mapped[bool | None] = mapped_column(default=None)
    reason: Mapped[str] = mapped_column(Text, default="")
    details: Mapped[dict[str, Any]] = mapped_column(default=dict)
    # Operational metrics for evaluators that call a model (LLM judges).
    latency_ms: Mapped[float | None] = mapped_column(Float, default=None)
    input_tokens: Mapped[int | None] = mapped_column(Integer, default=None)
    output_tokens: Mapped[int | None] = mapped_column(Integer, default=None)
    cost_usd: Mapped[float | None] = mapped_column(Float, default=None)
    error_message: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    result: Mapped[Result] = relationship(back_populates="scores")
    evaluator: Mapped[RunEvaluator] = relationship()

    __table_args__ = (UniqueConstraint("result_id", "run_evaluator_id"),)
