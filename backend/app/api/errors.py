"""Uniform error envelope: ``{"error": {"code", "message", "details"}}``."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.services.errors import ConflictError, DomainError, InvalidRequestError, NotFoundError

_STATUS_BY_ERROR: dict[type[DomainError], int] = {
    NotFoundError: 404,
    ConflictError: 409,
    InvalidRequestError: 422,
}


def _envelope(code: str, message: str, details: Any = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def handle_domain_error(_: Request, exc: DomainError) -> JSONResponse:
        status = next(
            (code for kind, code in _STATUS_BY_ERROR.items() if isinstance(exc, kind)), 400
        )
        return JSONResponse(
            status_code=status, content=_envelope(exc.code, exc.message, exc.details)
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                "loc": [str(part) for part in err.get("loc", ())],
                "message": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content=_envelope("validation_error", "Request validation failed", details),
        )
