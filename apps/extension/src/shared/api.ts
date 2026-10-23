/**
 * Browser API shim (section 9.7: `globalThis.browser ?? chrome`, so a Firefox port is mechanical) and the REST
 * helpers every extension context uses: `X-Requested-With: IndiansAssist`, `credentials: 'omit'` (Y21).
 */
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@indiansassist/shared';

export function ext(): typeof chrome {
  const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome };
  const api = g.browser ?? g.chrome;
  if (!api) throw new Error('extension API unavailable');
  return api;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type JsonResult = { status: number; ok: boolean; body: unknown };

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function call(url: string, init: RequestInit, fetchImpl: FetchLike, timeoutMs: number): Promise<JsonResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, credentials: 'omit', signal: ctl.signal });
    return { status: res.status, ok: res.ok, body: await readJson(res) };
  } finally {
    clearTimeout(timer);
  }
}

export function postJson(url: string, body: unknown, fetchImpl: FetchLike = fetch, timeoutMs = 10000): Promise<JsonResult> {
  return call(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE },
      body: JSON.stringify(body),
    },
    fetchImpl,
    timeoutMs,
  );
}

export function getJson(url: string, fetchImpl: FetchLike = fetch, timeoutMs = 10000): Promise<JsonResult> {
  return call(url, { method: 'GET', headers: { [CSRF_HEADER]: CSRF_HEADER_VALUE } }, fetchImpl, timeoutMs);
}

/** `{ error: { code, details } }` of an api error body, or nulls. */
export function apiError(body: unknown): { code: string | null; details: Record<string, unknown> | null } {
  const e = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  return {
    code: typeof e?.code === 'string' ? e.code : null,
    details: e?.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : null,
  };
}
