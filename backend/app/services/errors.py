"""Domain-level errors raised by services and translated to HTTP responses by the API layer."""

from typing import Any


class DomainError(Exception):
    code = "domain_error"

    def __init__(self, message: str, *, details: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


class NotFoundError(DomainError):
    code = "not_found"

    @classmethod
    def for_entity(cls, entity: str, entity_id: str) -> "NotFoundError":
        return cls(f"{entity} '{entity_id}' was not found")


class ConflictError(DomainError):
    code = "conflict"


class InvalidRequestError(DomainError):
    code = "invalid_request"
