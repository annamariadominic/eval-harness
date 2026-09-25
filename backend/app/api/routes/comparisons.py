from typing import Annotated

from fastapi import APIRouter, Query

from app.analysis.slices import DEFAULT_SLICE_THRESHOLD
from app.api.deps import SessionDep
from app.schemas.comparisons import CaseResults, ComparisonReport
from app.services import comparisons as service

router = APIRouter(tags=["analysis"])


@router.get("/compare", response_model=ComparisonReport)
async def compare(
    session: SessionDep,
    target: Annotated[str, Query(description="Run variant id of the candidate arm.")],
    base: Annotated[str | None, Query(description="Run variant id to compare against.")] = None,
    slice_threshold: Annotated[float, Query(ge=0, le=1)] = DEFAULT_SLICE_THRESHOLD,
    slice_evaluator: Annotated[
        str | None, Query(description="Evaluator key to slice on instead of case scores.")
    ] = None,
) -> ComparisonReport:
    """Aggregate metrics, per-case regressions, and tag slices for one or two arms."""
    return await service.build_comparison(session, target, base, slice_threshold, slice_evaluator)


@router.get("/case-results", response_model=CaseResults)
async def case_results(
    session: SessionDep,
    test_case_id: str,
    arms: Annotated[list[str], Query(description="Run variant ids to include.")],
) -> CaseResults:
    """Everything recorded for one test case across the given arms, for side-by-side review."""
    return await service.get_case_results(session, test_case_id, arms)
