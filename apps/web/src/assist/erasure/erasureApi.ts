/**
 * Org erasure REST calls (docs/specs/phase-f-contracts.md section 5.6), validated with the shared schemas, and the
 * confirmation fragment of the single-admin path (5.2f): read from `#confirm=<token>`, kept in sessionStorage only
 * across a sign-in, and removed from the address bar at once so it never stays in the history.
 */
import {
  erasureReplySchema,
  erasureStatusReplySchema,
  type ErasureNotice,
  type ErasureReply,
  type ErasureStatusReply,
  type OrgErasure,
} from '@indiansassist/shared';
import { api } from '../../lib/api';

export const erasureApi = {
  status: (signal?: AbortSignal) => api.get<ErasureStatusReply>('/orgs/current/erasure', { schema: erasureStatusReplySchema, ...(signal ? { signal } : {}) }),
  request: (body: { confirmSlug: string; reason?: string; solo?: boolean }) => api.post<ErasureReply>('/orgs/current/erasure', body, { schema: erasureReplySchema }),
  approve: (id: string, confirmSlug: string) => api.post<ErasureReply>(`/orgs/current/erasure/${id}/approve`, { confirmSlug }, { schema: erasureReplySchema }),
  confirm: (id: string, token: string) => api.post<ErasureReply>(`/orgs/current/erasure/${id}/confirm`, { token }, { schema: erasureReplySchema }),
  cancel: (id: string) => api.post<ErasureReply>(`/orgs/current/erasure/${id}/cancel`, {}, { schema: erasureReplySchema }),
};

/** The record (org_admin, auditor) or the notice (every other role) of a status reply. */
export function recordOf(r: ErasureStatusReply | undefined): OrgErasure | null {
  return r && 'erasure' in r ? r.erasure : null;
}

export function noticeOf(r: ErasureStatusReply | undefined): ErasureNotice | null {
  if (!r) return null;
  if ('notice' in r) return r.notice;
  const e = r.erasure;
  return e ? { state: e.state, coolingOffUntil: e.coolingOffUntil, certificateUrl: e.certificateUrl } : null;
}

export const OPEN_STATES = ['pending_confirmation', 'pending_approval', 'cooling_off', 'executing'] as const;

export function isOpen(state: string | undefined | null): boolean {
  return state !== undefined && state !== null && (OPEN_STATES as readonly string[]).includes(state);
}

/** Dispatched on `window` by the erasure page after a change, so the banner reloads. */
export const ERASURE_CHANGED_EVENT = 'ia:erasure-changed';

export function announceErasureChanged(): void {
  globalThis.dispatchEvent(new Event(ERASURE_CHANGED_EVENT));
}

const CONFIRM_KEY = 'ia.erasure.confirm';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Takes a `#confirm=<token>` fragment off the current URL (replacing the history entry) and keeps it in
 * sessionStorage, so a sign-in in between does not lose it. Returns the pending token, if any.
 */
export function takeConfirmToken(): string | null {
  try {
    const m = /(?:^#|&)confirm=([A-Za-z0-9_-]{43})(?:&|$)/.exec(globalThis.location.hash);
    if (m) {
      sessionStorage.setItem(CONFIRM_KEY, m[1]!);
      globalThis.history.replaceState(globalThis.history.state, '', `${globalThis.location.pathname}${globalThis.location.search}`);
    }
    const kept = sessionStorage.getItem(CONFIRM_KEY);
    return kept && TOKEN_RE.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

export function clearConfirmToken(): void {
  try {
    sessionStorage.removeItem(CONFIRM_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** "9 November 2026, 10:02" in the viewer's time zone, with the zone named. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return 'not set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'not set';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

/** The state in words (the banner and the page). */
export function stateWords(state: string): string {
  switch (state) {
    case 'pending_confirmation':
      return 'waiting for the administrator to confirm it from the mailed link';
    case 'pending_approval':
      return "waiting for a second administrator's approval";
    case 'cooling_off':
      return 'scheduled; it can still be cancelled';
    case 'executing':
      return 'running now';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired without approval';
    default:
      return state;
  }
}
