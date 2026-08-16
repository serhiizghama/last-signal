/**
 * The i18n key + params the server attaches to every non-2xx response
 * (`{ error: { key, params } }` — see `apps/server`'s `errorBody` helper). The client never
 * invents its own prose: it always has a key to hand to i18next.
 */
export interface ApiErrorBody {
  key: string;
  params: Record<string, unknown>;
}

/** Key used when the server's response can't be parsed as `ApiErrorBody` (or there's no server response at all). */
export const GENERIC_ERROR_KEY = 'errors.generic';

/** Thrown by `request` for every non-2xx response, and for network failures that never reach the server. */
export class ApiError extends Error {
  readonly key: string;
  readonly params: Record<string, unknown>;
  /** HTTP status, or `0` for a network failure that never produced a response. */
  readonly status: number;

  constructor(key: string, params: Record<string, unknown>, status: number) {
    super(`ApiError: ${key} (status ${String(status)})`);
    this.name = 'ApiError';
    this.key = key;
    this.params = params;
    this.status = status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    (value.params === undefined || isRecord(value.params))
  );
}

function extractErrorBody(value: unknown): ApiErrorBody | undefined {
  if (!isRecord(value) || !('error' in value)) {
    return undefined;
  }
  const candidate = value.error;
  if (!isApiErrorBody(candidate)) {
    return undefined;
  }
  return { key: candidate.key, params: candidate.params ?? {} };
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const HTTP_NO_CONTENT = 204;

/**
 * The one place that talks to `/api`. Always sends the httpOnly session cookie
 * (`credentials: 'include'`), always uses a relative path (never a hardcoded origin — the
 * dev proxy and production Caddy both route `/api` for us), and always turns a non-2xx
 * response into a typed `ApiError` so callers can translate `error.key` through i18next
 * instead of branching on prose or status codes.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    // A network failure never reaches the server, so there's no `{ error: { key } }` body to
    // read — fall back to the generic key rather than surfacing the raw browser message.
    throw new ApiError(GENERIC_ERROR_KEY, {}, 0);
  }

  if (!response.ok) {
    const parsed = await parseJsonSafely(response);
    const errorBody = extractErrorBody(parsed);
    throw new ApiError(
      errorBody?.key ?? GENERIC_ERROR_KEY,
      errorBody?.params ?? {},
      response.status,
    );
  }

  if (response.status === HTTP_NO_CONTENT) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const apiClient = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
    request<T>(path, { method: 'POST', body, signal }),
};
