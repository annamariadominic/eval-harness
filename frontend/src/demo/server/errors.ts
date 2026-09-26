/** Ports of `app/services/errors.py` and the API's error envelope (`app/api/errors.py`). */

export class DomainError extends Error {
  readonly code: string = "domain_error";
  readonly status: number = 400;

  constructor(
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  readonly code = "not_found";
  readonly status = 404;

  static forEntity(entity: string, id: string): NotFoundError {
    return new NotFoundError(`${entity} '${id}' was not found`);
  }
}

export class ConflictError extends DomainError {
  readonly code = "conflict";
  readonly status = 409;
}

export class InvalidRequestError extends DomainError {
  readonly code = "invalid_request";
  readonly status = 422;
}

/** FastAPI's `RequestValidationError`, reported as `validation_error` with per-field details. */
export class RequestValidationError extends DomainError {
  readonly code = "validation_error";
  readonly status = 422;

  constructor(details: Array<{ loc: string[]; message: string; type: string }>) {
    super("Request validation failed", details);
  }
}

export function envelope(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details } };
}
