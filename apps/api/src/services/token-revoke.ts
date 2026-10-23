/**
 * Token revocation (contracts sections 6.6, 6.7, 7.3): `active -> revoked` with `token.revoked { reason }`, then every
 * non-ended session on the token ends with `token_revoked`, and waiting Desk sockets on it are closed.
 */
import type { TokenRevokeReason } from '@indiansassist/shared';
import { getOrgOrThrow, listOpenSessionsByToken, revokeToken, type Executor, type TokenRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { writeAudit, type Actor } from '../lib/audit.js';
import { endSessionQuietly } from './session-end.js';

/** Revokes inside `exec` (a transaction or the db); returns null when the token does not exist. */
export async function revokeTokenRow(
  ctx: AppContext,
  exec: Executor,
  tokenId: string,
  reason: TokenRevokeReason,
  actor: Actor,
): Promise<{ token: TokenRow; changed: boolean } | null> {
  const res = await revokeToken(exec, tokenId, actor.type === 'user' ? actor.id : null);
  if (!res || !res.changed) return res;
  const org = await getOrgOrThrow(exec, res.token.orgId);
  await writeAudit(ctx, exec, org, {
    actor,
    action: 'token.revoked',
    data: { tokenId, reason },
  });
  return res;
}

/**
 * After a committed revocation: drop the token's waiting Desk sockets first (no DB work, cannot fail), then end each
 * non-ended session on it; one failing session does not skip the others (SEC-09). The sweeper ends whatever is left
 * (a crash between the commit and this cascade) with `token_revoked`.
 */
export async function afterTokenRevoked(ctx: AppContext, tokenId: string, actor: Actor): Promise<void> {
  ctx.hub.tokenRevoked(tokenId);
  for (const s of await listOpenSessionsByToken(ctx.db, tokenId)) {
    try {
      await endSessionQuietly(ctx, s.id, { reason: 'token_revoked', actor });
    } catch (err) {
      ctx.log.error({ err, sessionId: s.id, tokenId }, 'revocation cascade failed for a session; the sweeper retries');
    }
  }
}

export async function revokeTokenAndCascade(
  ctx: AppContext,
  tokenId: string,
  reason: TokenRevokeReason,
  actor: Actor,
): Promise<{ token: TokenRow; changed: boolean } | null> {
  const res = await ctx.db.transaction((tx) => revokeTokenRow(ctx, tx, tokenId, reason, actor));
  if (res?.changed) await afterTokenRevoked(ctx, tokenId, actor);
  return res;
}
