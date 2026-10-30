/**
 * Object scope checks of the section 2.3 matrix for sessions (and the recordings and audit that hang off them):
 * cross-org objects are `404 not_found`; same-org objects outside a technician's `own` scope are `403 forbidden`.
 * `own` for sessions = `assist_user_id` is the caller OR `token.created_by` is the caller.
 */
import { assistMayRecord } from '@indiansassist/shared';
import { findTokenByTid, getSession, type SessionRow, type TokenRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import type { Principal } from '../plugins/auth.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ScopeOpts = {
  /** Observers may read sessions but never audit or recordings. */
  allowObserver?: boolean;
  /** Write actions (end): auditors and observers are refused. */
  write?: boolean;
};

export async function scopedSession(
  ctx: AppContext,
  p: Principal,
  id: string,
  opts: ScopeOpts = {},
): Promise<{ session: SessionRow; token: TokenRow }> {
  const s = UUID_RE.test(id) ? await getSession(ctx.db, id) : null;
  if (!s || s.orgId !== p.org.id) fail('not_found', 'session not found');
  const tok = await findTokenByTid(ctx.db, s.tokenId);
  if (!tok) fail('not_found', 'session not found');
  const role = p.user.role;
  if (role === 'observer' && (!opts.allowObserver || opts.write)) fail('forbidden', 'your role cannot do this');
  if (role === 'auditor' && opts.write) fail('forbidden', 'read-only role');
  if (role === 'technician' && s.assistUserId !== p.user.id && tok.createdBy !== p.user.id)
    fail('forbidden', 'not your session');
  return { session: s, token: tok };
}

/**
 * "assist of the session" (events, recording upload, ICE): the user who ACCEPTED the knock. `assist_user_id` is
 * seeded with the token creator at knock time, so a session that ended from `knocked` (denied, timeout, revoked)
 * has no assist at all: `accepted_at` must be set (SEC-06).
 */
export function requireSessionAssist(p: Principal, s: SessionRow): void {
  if (s.acceptedAt === null || s.assistUserId !== p.user.id)
    fail('forbidden', 'only the assist of the session may do this');
}

/** Recordings and file attestations exist only for sessions that reached `active` (consent was given). */
export function requireReachedActive(s: SessionRow): void {
  if (s.startedAt === null) fail('forbidden', 'the session never reached active (no consent was given)');
}

/**
 * Phase A.2 section 3: the Assist console may record a P1 session only under `assist_only` / `both` (null = before
 * A.2 = `assist_only`). The server recorder captures P1 video only, so other tiers are refused only under `off`.
 */
export function assistMayRecordSession(s: Pick<SessionRow, 'tier' | 'recordingMode'>): boolean {
  // Phase C section 9 R1: the P3 console records the remote video exactly as P1.
  return s.tier === 'p1_browser' || s.tier === 'p3_portable' ? assistMayRecord(s.recordingMode) : s.recordingMode !== 'off';
}

export function requireAssistMayRecord(s: Pick<SessionRow, 'tier' | 'recordingMode'>): void {
  if (!assistMayRecordSession(s)) fail('forbidden', 'console recording is disabled by the organisation policy');
}
