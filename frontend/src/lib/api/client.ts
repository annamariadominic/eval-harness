/** Thin fetch wrapper that turns the backend's error envelope into typed errors. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type ErrorEnvelope = { error?: { code?: string; message?: string; details?: unknown } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope;
    throw new ApiError(
      response.status,
      envelope.error?.code ?? "http_error",
      envelope.error?.message ?? `Request failed with status ${response.status}`,
      envelope.error?.details ?? null,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: (path: string) => request<void>("DELETE", path),
};

export function query(params: Record<string, string | string[] | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
