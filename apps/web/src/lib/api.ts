/**
 * REST client (contracts sections 6.1, 6.2). Every request carries the cookie (`credentials: 'include'`);
 * every non-GET/HEAD request carries the CSRF header `X-Requested-With: IndiansAssist`. Non-2xx answers
 * are turned into `ApiRequestError` with the envelope's `code` and `details`. Responses are checked
 * against the shared zod schema when one is given; a mismatch is logged and the raw body is returned, so
 * a cosmetic drift on the server never blanks a screen.
 */
import { CSRF_HEADER, CSRF_HEADER_VALUE, type ApiErrorCode } from '@indiansassist/shared';
import { API_BASE } from '../config';

type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'network_error' | 'bad_response';
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: ApiRequestError['code'], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(e: unknown, code?: string): e is ApiRequestError {
  return e instanceof ApiRequestError && (code === undefined || e.code === code);
}

/** Human readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.code === 'network_error') return 'Could not reach the server.';
    if (e.code === 'rate_limited') {
      const s = Number(e.details?.retryAfterSec);
      return Number.isFinite(s) ? `Too many attempts, try again in ${s} s.` : 'Too many attempts, try again shortly.';
    }
    return e.message || e.code;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export type RequestOptions<T> = {
  body?: unknown;
  schema?: Schema<T>;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined | null>;
  /** Return the raw Response (blob downloads). */
  raw?: boolean;
};

export function buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export function csrfHeaders(method: string): Record<string, string> {
  return method === 'GET' || method === 'HEAD' ? {} : { [CSRF_HEADER]: CSRF_HEADER_VALUE };
}

async function toError(res: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)
    ?.error;
  if (err && typeof err.code === 'string') {
    return new ApiRequestError(res.status, err.code as ApiErrorCode, err.message ?? err.code, err.details);
  }
  return new ApiRequestError(res.status, res.status >= 500 ? 'internal' : 'bad_response', `HTTP ${res.status}`);
}

export async function request<T = unknown>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
  const headers: Record<string, string> = { ...csrfHeaders(method) };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      body,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'network_error', 'Could not reach the server.');
  }
  if (!res.ok) throw await toError(res);
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json: unknown = text === '' ? null : JSON.parse(text);
  if (!opts.schema) return json as T;
  const parsed = opts.schema.safeParse(json);
  if (parsed.success) return parsed.data;
  console.warn(`[api] ${method} ${path}: response does not match the shared schema`, parsed.error);
  return json as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions<T>) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions<T>) => request<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions<T>) => request<T>('PATCH', path, { ...opts, body }),
};
