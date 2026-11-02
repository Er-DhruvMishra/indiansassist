/**
 * What every ticketing adapter shares (docs/specs/phase-e-contracts.md sections 4.1, 4.3, 4.6): one upstream call
 * through the egress guard turned into a value (never thrown past the adapter, section 2.2 G7), the `Retry-After`
 * parser, the sanitised failure detail and the body conversions (Atlassian Document Format, Jira wiki escaping, HTML).
 * Response bodies are parsed only for the named fields and never logged.
 */
import { classifyHttpFailure, type EgressPurpose, type IntegrationType, type TicketFailure, type TicketFailureCause, type TicketPriority } from '@indiansassist/shared';
import { EgressFailedError, EgressRefusedError } from '../lib/egress.js';
import type { AdapterCtx, AdapterResult } from './adapter.js';

/** Upstream response bodies are read up to 1 MiB (section 4.6). */
export const UPSTREAM_MAX_BYTES = 1_048_576;
const RETRY_AFTER_CAP_SEC = 7200;

export type UpstreamCall = {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  /** A JSON body (serialised here), a form body, or raw bytes (the webhook's canonical JSON). */
  json?: unknown;
  form?: Record<string, string>;
  raw?: Uint8Array;
  purpose?: EgressPurpose;
};

export type UpstreamOk = { status: number; json: unknown; headers: Headers };

/** A failure value (the `detail` is cut to 200 characters and stripped of control characters). */
export function failure(cause: TicketFailureCause, over: Partial<Omit<TicketFailure, 'cause'>> = {}): TicketFailure {
  return {
    cause,
    status: over.status ?? null,
    retryAfterSec: over.retryAfterSec ?? null,
    sent: over.sent ?? false,
    detail: sanitiseDetail(over.detail ?? cause),
  };
}

export function fail<R>(cause: TicketFailureCause, over: Partial<Omit<TicketFailure, 'cause'>> = {}): AdapterResult<R> {
  return { ok: false, failure: failure(cause, over) };
}

export function sanitiseDetail(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
}

/** `Retry-After` as delta seconds or an HTTP date, capped at 7200 s; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Math.min(Number(v), RETRY_AFTER_CAP_SEC);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, Math.ceil((at - now.getTime()) / 1000)), RETRY_AFTER_CAP_SEC);
}

/** A short upstream error code from a JSON error body (never free text, headers or the body itself). */
export function upstreamErrorCode(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const candidates: unknown[] = [o['errorCode'], o['code'], o['error'], o['error_code']];
  const err = o['error'];
  if (err && typeof err === 'object') candidates.push((err as Record<string, unknown>)['code'], (err as Record<string, unknown>)['message']);
  for (const c of candidates) if (typeof c === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(c)) return c;
  return null;
}

/** The part of an adapter context one upstream call needs. */
export type CallCtx = Pick<AdapterCtx<IntegrationType>, 'orgId' | 'fetch' | 'now' | 'deadline'>;

function remainingMs(c: Pick<CallCtx, 'deadline'>): number {
  return Math.max(1, c.deadline - Date.now());
}

/**
 * One upstream request through the egress guard. 2xx answers `{ ok, status, json }`; anything else is a failure
 * value classified by section 4.1: an HTTP status by `classifyHttpFailure`, an egress refusal as `egress_refused`,
 * a DNS failure or a refused connection as `unreachable` (`sent: false`), a timeout as `timeout` (`sent: true`) and a
 * connection reset after the request may have been written as `upstream_error` with no status (`sent: true`).
 */
export async function upstream(c: CallCtx, call: UpstreamCall): Promise<{ ok: true; res: UpstreamOk } | { ok: false; failure: TicketFailure }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(call.headers ?? {}) };
  let body: string | Uint8Array | undefined;
  if (call.json !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    body = JSON.stringify(call.json);
  } else if (call.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(call.form).toString();
  } else if (call.raw) {
    body = call.raw;
  }
  let res: Response;
  try {
    res = await c.fetch(
      call.url,
      { method: call.method, headers, ...(body !== undefined ? { body: body as NonNullable<RequestInit['body']> } : {}) },
      { purpose: call.purpose ?? 'ticketing', orgId: c.orgId, timeoutMs: remainingMs(c), maxResponseBytes: UPSTREAM_MAX_BYTES },
    );
  } catch (err) {
    if (err instanceof EgressRefusedError) {
      // A redirect or an over-long answer means the request did reach the far end.
      const sent = err.cause === 'redirect' || err.cause === 'too_large';
      return { ok: false, failure: failure('egress_refused', { sent, detail: `egress refused: ${err.cause}` }) };
    }
    if (err instanceof EgressFailedError) {
      if (err.kind === 'timeout') return { ok: false, failure: failure('timeout', { sent: true, detail: 'no answer within the attempt timeout' }) };
      if (!err.sent) return { ok: false, failure: failure('unreachable', { sent: false, detail: err.kind === 'dns' ? 'host did not resolve' : 'connection refused' }) };
      return { ok: false, failure: failure('upstream_error', { sent: true, detail: 'connection lost before an answer' }) };
    }
    return { ok: false, failure: failure('upstream_error', { sent: true, detail: 'transport error' }) };
  }
  let json: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, res: { status: res.status, json, headers: res.headers } };
  const cause = classifyHttpFailure(res.status, true);
  const code = upstreamErrorCode(json);
  return {
    ok: false,
    failure: failure(cause, {
      status: res.status,
      sent: true,
      retryAfterSec: parseRetryAfter(res.headers.get('retry-after'), c.now()),
      detail: `HTTP ${res.status}${code ? ` ${code}` : ''}`,
    }),
  };
}

/** The value at a dotted path of a parsed body when it is a string or a finite number (ids arrive as either). */
export function pick(json: unknown, ...path: string[]): string | null {
  let v: unknown = json;
  for (const k of path) {
    if (!v || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[k];
  }
  if (typeof v === 'string' && v.length > 0 && v.length <= 200) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** An https URL from an upstream body, else null (never an arbitrary scheme in the console). */
export function httpsUrl(v: string | null): string | null {
  if (!v || v.length > 2048) return null;
  try {
    return new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

/** An origin without a trailing slash. */
export function originOf(url: string): string {
  return url.replace(/\/+$/, '');
}

// ---------- body conversions (section 4.3) ----------

/** Plain text to HTML-escaped text inside `<p>` with `<br>` line breaks (Zoho Desk, Freshdesk). */
export function toHtml(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<p>${esc.replace(/\r\n|\r|\n/g, '<br>')}</p>`;
}

export type AdfDoc = { type: 'doc'; version: 1; content: { type: 'paragraph'; content: { type: 'text'; text: string }[] }[] };

/** Plain text to an Atlassian Document Format document with one paragraph per line (Jira cloud). */
export function toAdf(text: string): AdfDoc {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\r\n|\r|\n/).map((line) => ({ type: 'paragraph' as const, content: line === '' ? [] : [{ type: 'text' as const, text: line }] })),
  };
}

/** Plain text with the Jira wiki markup characters `{ [ | * _` escaped (Jira data_center). */
export function toJiraWiki(text: string): string {
  return text.replace(/[{[|*_]/g, (ch) => `\\${ch}`);
}

/** One line (ticket subjects never carry line breaks). */
export function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

// ---------- priority mapping (section 4.6) ----------

export const ZOHO_PRIORITY: Record<TicketPriority, 'Low' | 'Medium' | 'High' | 'Urgent'> = { low: 'Low', normal: 'Medium', high: 'High', urgent: 'Urgent' };
export const FRESHDESK_PRIORITY: Record<TicketPriority, 1 | 2 | 3 | 4> = { low: 1, normal: 2, high: 3, urgent: 4 };
export const SERVICENOW_URGENCY: Record<TicketPriority, 1 | 2 | 3> = { low: 3, normal: 2, high: 1, urgent: 1 };
