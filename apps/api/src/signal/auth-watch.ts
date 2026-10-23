/**
 * Keeps long-lived sockets honest (contracts section 7.2):
 * - an Assist socket's cookie principal is re-read from `auth_session` / `user` every `timing.authRecheckMs` (and
 *   immediately after logout, password change, role or status change), so a revoked or expired cookie session, a
 *   disabled user or a role without "WS as Assist" closes the socket `4401` / `4403`, and a role change takes effect
 *   on the next knock (`canAct` is computed from the refreshed row);
 * - a waiting or held Desk whose token passed `expires_at` is told `token_gone { status: 'expired' }` and closed
 *   `4403` (section 3.2), so a held knock can never be performed on an expired token.
 */
import { WS_CLOSE } from '@indiansassist/shared';
import { findValidAuthSessionById } from '@indiansassist/db';
import { hasRole, TECH_ROLES } from '../lib/rbac.js';
import type { Conn } from './conn.js';
import type { SignalHub } from './hub.js';

/** Re-reads the principal of one socket; closes it when it is no longer allowed. */
export async function revalidateConn(hub: SignalHub, conn: Conn): Promise<void> {
  const p = conn.principal;
  if (!p || conn.closed) return;
  conn.lastAuthCheckAt = Date.now();
  const found = await findValidAuthSessionById(hub.ctx.db, p.authSession.id);
  if (!found || found.user.status !== 'active' || found.user.orgId !== p.org.id) {
    conn.error('not_authenticated', 'your sign-in is no longer valid');
    conn.close(WS_CLOSE.unauthenticated, 'session revoked');
    return;
  }
  p.user = found.user;
  p.authSession = found.session;
  if (conn.side === 'assist' && !hasRole(found.user.role, TECH_ROLES)) {
    conn.error('forbidden', 'your role can no longer connect as Assist');
    conn.close(WS_CLOSE.forbidden, 'role changed');
  }
}

/** Called from the hub tick: starts a re-validation for every authenticated socket that is due. */
export function runAuthChecks(hub: SignalHub, now: number): void {
  for (const c of hub.conns.values()) {
    if (!c.principal || c.closed || c.authCheckInFlight) continue;
    if (now - c.lastAuthCheckAt < hub.ctx.timing.authRecheckMs) continue;
    c.authCheckInFlight = true;
    revalidateConn(hub, c)
      .catch((err: unknown) => hub.ctx.log.error({ err, connectionId: c.id }, 'principal re-validation failed'))
      .finally(() => {
        c.authCheckInFlight = false;
      });
  }
}

/** Re-validates every socket of a user right away (role / status change). */
export async function refreshUserSockets(hub: SignalHub, userId: string): Promise<void> {
  const mine = [...hub.conns.values()].filter((c) => c.principal?.user.id === userId && !c.closed);
  await Promise.all(mine.map((c) => revalidateConn(hub, c)));
}

/** Waiting / held Desk sockets (no session yet) whose token expired. */
export function closeExpiredWaitingDesks(hub: SignalHub, now: number): void {
  for (const c of hub.conns.values()) {
    const d = c.desk;
    if (c.closed || c.side !== 'desk' || !d || d.sessionId !== null || d.tokenExpiresAt > now) continue;
    c.error('token_gone', 'token is expired', undefined, { status: 'expired' });
    c.close(WS_CLOSE.forbidden, 'token expired');
  }
}
