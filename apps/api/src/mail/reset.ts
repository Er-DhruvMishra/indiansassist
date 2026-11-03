/**
 * Phase F section 4.3: password reset. The request route answers `202 {}` at once and decides everything after the
 * reply (`afterReply`), so neither the body nor the latency depends on the account (rule 4.3a). The token is 32
 * CSPRNG bytes, stored only as `sha256Hex(token)`, single use, 30 minutes, superseded on reissue, carried in the
 * link's fragment and never logged, chained or returned (conventions table).
 */
import { randomBytes } from 'node:crypto';
import { isRegionServed, LIMITS, sha256Hex, WS_CLOSE, type ResetOutcome } from '@indiansassist/shared';
import {
  consumePasswordReset,
  findPasswordResetByHash,
  findUserByEmail,
  getOrg,
  getUser,
  insertPasswordReset,
  revokeUserAuthSessions,
  supersedePasswordResets,
  updateUser,
  user as userTable,
  type OrgRow,
  type UserRow,
} from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../adapters/auth-provider.js';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';
import { listOtherActiveAdmins } from '../sso/repo.js';
import { afterReply, mailAvailable, orgDisplayName, orgHasSso, sendMail, ssoBeginUrl } from './send.js';
import { breakGlassResetMail, resetMail, ssoNoticeMail } from './templates.js';

/** The presence key of the shared hourly cap of reset links and SSO notices (rule 4.3c). */
export function resetMailKey(userId: string): string {
  return `ia:resetmail:${userId}`;
}

/** `${WEB_ORIGIN}/reset#t=<token>` (rule 4.3d). */
export function resetUrlOf(ctx: Pick<AppContext, 'config'>, token: string): string {
  return `${ctx.config.webOrigin}/reset#t=${token}`;
}

/** What a request for this account earns (rule 4.3b). */
export type ResetPlan = 'none' | 'link' | 'sso_notice';

export function planReset(user: UserRow, org: OrgRow, served: boolean): ResetPlan {
  if (!served || user.status !== 'active' || org.erasingAt !== null || org.erasedAt !== null) return 'none';
  if (org.ssoRequired && !user.ssoBreakGlass) return 'sso_notice';
  if (user.passwordHash === null) return orgHasSso(org) ? 'sso_notice' : 'none';
  return 'link';
}

/** The after-reply half of `POST /auth/password-reset/request`. */
export async function handleResetRequest(ctx: AppContext, email: string): Promise<void> {
  const user = await findUserByEmail(ctx.db, email);
  const org = user ? await getOrg(ctx.db, user.orgId) : null;
  const plan: ResetPlan = user && org ? planReset(user, org, isRegionServed(org.dataRegion, ctx.config.servedRegions)) : 'none';
  if (!user || !org || plan === 'none') {
    // Unknown and ineligible accounts get nothing and chain nothing (there is no outcome to state).
    ctx.metrics.passwordResets.inc({ result: 'unknown' });
    return;
  }
  const outcome = await deliver(ctx, user, org, plan);
  ctx.metrics.passwordResets.inc({ result: outcome });
  await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'auth.password_reset_requested', data: { userId: user.id, outcome } });
}

async function deliver(ctx: AppContext, user: UserRow, org: OrgRow, kind: 'link' | 'sso_notice'): Promise<ResetOutcome> {
  // Rule 4.3c: one cap for both kinds, counted before any mail, so an SSO notice cannot be used to mail-bomb.
  const n = await ctx.presence.incr(resetMailKey(user.id), 3600);
  if (n > LIMITS.passwordResetPerHour) return 'throttled';
  if (!mailAvailable(ctx)) {
    // Rule 4.1c: with the log driver nothing that carries a token is "sent", and no token is minted.
    ctx.metrics.mailSent.inc({ kind: kind === 'link' ? 'reset' : 'reset_notice', result: 'no_mailer' });
    return 'no_mailer';
  }
  const orgName = orgDisplayName(org);
  if (kind === 'sso_notice') {
    const notice = ssoNoticeMail({ orgName, beginUrl: ssoBeginUrl(ctx, org, user.email) });
    const r = await sendMail(ctx, 'reset_notice', user.email, notice, { carriesSecret: false });
    return r === 'sent' ? 'sso_notice' : r === 'no_mailer' ? 'no_mailer' : 'send_failed';
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LIMITS.passwordResetTtlMin * 60_000);
  await ctx.db.transaction(async (tx) => {
    // The user row lock serialises two concurrent requests, so exactly one unused token remains.
    await tx.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, user.id)).for('update');
    await supersedePasswordResets(tx, user.id);
    await insertPasswordReset(tx, { userId: user.id, tokenHash: sha256Hex(token), expiresAt });
  });
  const r = await sendMail(ctx, 'reset', user.email, resetMail({ orgName, resetUrl: resetUrlOf(ctx, token), expiresAt }), { carriesSecret: true });
  if (r === 'sent') return 'mailed';
  // A link nobody received must not stay usable.
  await supersedePasswordResets(ctx.db, user.id);
  return r === 'no_mailer' ? 'no_mailer' : 'send_failed';
}

function invalid(ctx: AppContext): never {
  ctx.metrics.passwordResets.inc({ result: 'invalid' });
  fail('reset_invalid', 'this reset link is invalid, expired or was already used');
}

/**
 * `POST /auth/password-reset/confirm` (rule 4.3e): one `reset_invalid` for unknown, used, superseded and expired;
 * the user must still be eligible; argon2id hash, token used, every cookie session revoked and the chain entry in one
 * transaction; then the user's sockets close 4401. No session is minted.
 */
export async function confirmReset(ctx: AppContext, token: string, newPassword: string): Promise<void> {
  const hash = sha256Hex(token);
  const row = await findPasswordResetByHash(ctx.db, hash);
  if (!row || !safeEqual(row.tokenHash, hash) || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) invalid(ctx);
  const user = await getUser(ctx.db, row.userId);
  const org = user ? await getOrg(ctx.db, user.orgId) : null;
  if (!user || !org) invalid(ctx);
  const plan = planReset(user, org, isRegionServed(org.dataRegion, ctx.config.servedRegions));
  if (plan === 'sso_notice' && org.ssoRequired) {
    ctx.metrics.passwordResets.inc({ result: 'invalid' });
    fail('sso_required', 'your organisation signs in with single sign-on', { beginUrl: ssoBeginUrl(ctx, org, user.email) });
  }
  if (plan !== 'link') invalid(ctx);
  const passwordHash = await hashPassword(newPassword);
  const revokedSessions = await ctx.db.transaction(async (tx) => {
    if (!(await consumePasswordReset(tx, row.id))) return null;
    // Any other outstanding link of the user dies with this one.
    await supersedePasswordResets(tx, user.id);
    const updated = await updateUser(tx, user.id, { passwordHash });
    const revoked = await revokeUserAuthSessions(tx, user.id);
    await writeAudit(ctx, tx, org, { actor: userActor(updated), action: 'auth.password_reset', data: { userId: user.id, revokedSessions: revoked } });
    return revoked;
  });
  if (revokedSessions === null) invalid(ctx);
  ctx.metrics.passwordResets.inc({ result: 'confirmed' });
  // The A password-change path: every socket opened with a revoked cookie session closes 4401.
  ctx.hub.closeUserSockets(user.id, WS_CLOSE.unauthenticated);
  if (org.ssoRequired && user.ssoBreakGlass) afterReply(ctx, async () => void (await notifyBreakGlassReset(ctx, org, user)));
}

/** Rule 4.3f: every other active org_admin learns that a break-glass password was reset. Never throws. */
export async function notifyBreakGlassReset(ctx: AppContext, org: OrgRow, user: UserRow): Promise<number> {
  let sent = 0;
  try {
    const at = new Date();
    for (const a of await listOtherActiveAdmins(ctx.db, org.id, user.id)) {
      if (!a.email || !a.email.includes('@')) continue;
      const text = breakGlassResetMail({ name: user.name, orgName: orgDisplayName(org), at });
      if ((await sendMail(ctx, 'break_glass', a.email, text, { carriesSecret: false })) === 'sent') sent++;
    }
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'break-glass reset notice failed');
  }
  return sent;
}
