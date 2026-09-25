"""Dataset management: test case CRUD and JSON import."""

import json
from collections import Counter
from typing import Any

from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Suite, TestCase
from app.schemas.test_cases import (
    DatasetImportRequest,
    DatasetImportResult,
    ImportIssue,
    TestCaseCreate,
    TestCaseUpdate,
)
from app.services.common import get_or_404
from app.services.errors import ConflictError, InvalidRequestError

IMPORT_FIELDS = frozenset({"key", "input", "expected", "tags", "metadata"})
ALLOWED_FIELDS_TEXT = ", ".join(sorted(IMPORT_FIELDS))
PREVIEW_LIMIT = 50


async def list_test_cases(
    session: AsyncSession, suite_id: str, *, tag: str | None = None, search: str | None = None
) -> list[TestCase]:
    await get_or_404(session, Suite, suite_id)
    cases = (
        await session.scalars(
            select(TestCase).where(TestCase.suite_id == suite_id).order_by(TestCase.created_at)
        )
    ).all()
    if tag:
        cases = [c for c in cases if tag in c.tags]
    if search:
        needle = search.casefold()
        cases = [
            c
            for c in cases
            if needle in (c.key or "").casefold()
            or needle in json.dumps(c.input, ensure_ascii=False).casefold()
            or needle in json.dumps(c.expected, ensure_ascii=False).casefold()
        ]
    return list(cases)


async def _ensure_key_available(
    session: AsyncSession, suite_id: str, key: str | None, exclude_id: str | None = None
) -> None:
    if key is None:
        return
    query = select(TestCase.id).where(TestCase.suite_id == suite_id, TestCase.key == key)
    if exclude_id:
        query = query.where(TestCase.id != exclude_id)
    if await session.scalar(query):
        raise ConflictError(f"A test case with key '{key}' already exists in this suite")


async def create_test_case(session: AsyncSession, suite_id: str, data: TestCaseCreate) -> TestCase:
    await get_or_404(session, Suite, suite_id)
    await _ensure_key_available(session, suite_id, data.key)
    case = TestCase(
        suite_id=suite_id,
        key=data.key,
        input=data.input,
        expected=data.expected,
        tags=data.tags,
        meta=data.metadata,
    )
    session.add(case)
    await session.commit()
    return case


async def update_test_case(session: AsyncSession, case_id: str, data: TestCaseUpdate) -> TestCase:
    case = await get_or_404(session, TestCase, case_id)
    changes = data.model_dump(exclude_unset=True)
    if "input" in changes and changes["input"] in (None, "", {}):
        raise InvalidRequestError("input must not be empty")
    if "key" in changes:
        key = (changes["key"] or "").strip() or None
        await _ensure_key_available(session, case.suite_id, key, exclude_id=case.id)
        case.key = key
    if "input" in changes:
        case.input = changes["input"]
    if "expected" in changes:
        case.expected = changes["expected"]
    if changes.get("tags") is not None:
        case.tags = changes["tags"]
    if changes.get("metadata") is not None:
        case.meta = changes["metadata"]
    await session.commit()
    return case


async def delete_test_case(session: AsyncSession, case_id: str) -> None:
    case = await get_or_404(session, TestCase, case_id)
    await session.delete(case)
    await session.commit()


def validate_import(
    raw_cases: list[dict[str, Any]], existing_keys: set[str]
) -> tuple[list[TestCaseCreate], list[ImportIssue]]:
    """Validate every item, collecting all problems instead of stopping at the first."""
    parsed: list[TestCaseCreate] = []
    issues: list[ImportIssue] = []
    seen_keys: dict[str, int] = {}
    for index, raw in enumerate(raw_cases):
        if not isinstance(raw, dict):
            issues.append(ImportIssue(index=index, field="", message="Each case must be an object"))
            continue
        for unknown in sorted(set(raw) - IMPORT_FIELDS):
            issues.append(
                ImportIssue(
                    index=index,
                    field=unknown,
                    message=f"Unknown field '{unknown}'. Allowed: {ALLOWED_FIELDS_TEXT}",
                )
            )
        try:
            case = TestCaseCreate.model_validate(raw)
        except ValidationError as exc:
            for error in exc.errors():
                field = ".".join(str(p) for p in error["loc"]) or "(case)"
                issues.append(ImportIssue(index=index, field=field, message=error["msg"]))
            continue
        if case.key is not None:
            if case.key in seen_keys:
                first = seen_keys[case.key]
                issues.append(
                    ImportIssue(
                        index=index,
                        field="key",
                        message=f"Duplicate key '{case.key}' (first used by case {first})",
                    )
                )
            elif case.key in existing_keys:
                issues.append(
                    ImportIssue(
                        index=index,
                        field="key",
                        message=f"Key '{case.key}' already exists in this suite",
                    )
                )
            seen_keys.setdefault(case.key, index)
        parsed.append(case)
    return parsed, issues


async def import_test_cases(
    session: AsyncSession, suite_id: str, request: DatasetImportRequest
) -> DatasetImportResult:
    await get_or_404(session, Suite, suite_id)
    if not request.cases:
        raise InvalidRequestError("The import contains no test cases")

    existing = (await session.scalars(select(TestCase).where(TestCase.suite_id == suite_id))).all()
    existing_keys = (
        set() if request.mode == "replace" else {c.key for c in existing if c.key is not None}
    )
    parsed, issues = validate_import(request.cases, existing_keys)
    valid = not issues
    tag_counts = Counter(tag for case in parsed for tag in case.tags)

    created = replaced = 0
    if valid and not request.dry_run:
        if request.mode == "replace":
            replaced = len(existing)
            await session.execute(delete(TestCase).where(TestCase.suite_id == suite_id))
        session.add_all(
            TestCase(
                suite_id=suite_id,
                key=case.key,
                input=case.input,
                expected=case.expected,
                tags=case.tags,
                meta=case.metadata,
            )
            for case in parsed
        )
        await session.commit()
        created = len(parsed)

    return DatasetImportResult(
        valid=valid,
        dry_run=request.dry_run,
        mode=request.mode,
        total=len(request.cases),
        created=created,
        replaced=replaced,
        errors=issues,
        preview=parsed[:PREVIEW_LIMIT],
        tag_counts=dict(tag_counts.most_common()),
    )
