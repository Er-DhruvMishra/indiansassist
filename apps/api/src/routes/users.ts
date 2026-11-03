/**
 * User routes (contracts sections 2.4, 6.6): list, invite (seat with tier capped by org.plan_tier), role change
 * (seat created / updated / removed, last org_admin protected) and status change (disable cascades to cookie
 * sessions, tokens, their live sessions and the user's Assist sockets). Phase F rule 5.2e: each of the three asks
 * `assertNoOpenErasure` first (the admin set is frozen while an erasure is open; the erasure stream owns the body),
 * and rule 5.2b: `role_since` / `role_granted_by` are written at the invite and on every role change. Phase F section
 * 4.2 (stream mail): the invite mails the link after its transaction commits (`sendEmail`, default on when invite mail
 * is available) and answers `mailed`; `POST /users/:id/invite/resend` rotates the secret and mails it again.
 */
import {
  inviteRequestSchema,
  pageQuerySchema,
  roleChangeRequestSchema,
  roleHasSeat,
  sha256Hex,
  statusChangeRequestSchema,
  tierWithin,
  WS_CLOSE,
  type PackageTier,
} from '@indiansassist/shared';
import {
  countOrgAdmins,
  createSeat,
  createUser,
  deleteSeatByUser,
  findUserByEmail,
  getSeatByUser,
  getUser,
  isUniqueViolation,
  listActiveTokensByCreator,
  listUsersByOrg,
  revokeUserAuthSessions,
  updateSeat,
  updateUser,
  type OrgRow,
  type UserRow,
} from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { piiHash, userActor, writeAudit } from '../lib/audit.js';
import { randomSecret } from '../lib/crypto.js';
import { toSeat, toUser } from '../lib/mappers.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';
import { afterTokenRevoked, revokeTokenRow } from '../services/token-revoke.js';
import { clearBreakGlass, countUsableBreakGlass } from '../sso/repo.js';
import { assertNoOpenErasure } from '../erasure/guard.js';
import { INVITE_TTL_MS, inviteUrlOf, mailInvite, shouldMailInvite } from '../mail/invite.js';
import { mailAvailable } from '../mail/send.js';

/** Section 2.3: resends per target user and per org, per hour. */
const RESEND_PER_USER_HOUR = 5;
const RESEND_PER_ORG_HOUR = 30;

async function limitHour(ctx: AppContext, key: string, max: number): Promise<void> {
  const lim = await ctx.limiter.hit(key, max, 3_600_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    fail('rate_limited', 'too many requests', { retryAfterSec: lim.retryAfterSec });
  }
}

function checkTier(org: OrgRow, tier: PackageTier): void {
  if (!tierWithin(tier, org.planTier)) fail('tier_not_licensed', `the org plan does not include ${tier}`);
}

/**
 * Phase E rule 3.7e: while SSO is required, the last usable break-glass administrator cannot be moved off org_admin
 * or disabled.
 */
async function guardLastBreakGlass(ctx: AppContext, org: OrgRow, target: UserRow): Promise<void> {
  if (!org.ssoRequired || !target.ssoBreakGlass) return;
  if ((await countUsableBreakGlass(ctx.db, org.id, target.id)) === 0)
    fail('last_break_glass', 'SSO is required and this is the last break-glass administrator');
}

async function orgUser(ctx: AppContext, org: OrgRow, id: string): Promise<UserRow> {
  const u = /^[0-9a-f-]{36}$/.test(id) ? await getUser(ctx.db, id) : null;
  if (!u || u.orgId !== org.id) fail('not_found', 'user not found');
  return u;
}

export async function userRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/users', async (req) => {
    const p = await authenticate(ctx, req, ['senior_technician', 'org_admin', 'auditor']);
    const q = parseOr400(pageQuerySchema, req.query);
    const page = await listUsersByOrg(ctx.db, p.org.id, { limit: q.limit, cursor: q.cursor ?? null });
    return { items: page.items.map((u) => ({ ...toUser(u), seat: toSeat(u.seat) })), nextCursor: page.nextCursor };
  });

  app.post('/api/v1/users/invite', async (req, reply) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(inviteRequestSchema, req.body);
    const seatTier: PackageTier | null = roleHasSeat(body.role) ? (body.tier ?? 'p1_browser') : null;
    if (seatTier) checkTier(p.org, seatTier);
    await assertNoOpenErasure(ctx, p.org, { kind: 'invite', role: body.role });
    if (await findUserByEmail(ctx.db, body.email)) fail('email_taken', 'an account with this email exists');
    const secret = randomSecret(32);
    const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
    let user: UserRow;
    try {
      user = await ctx.db.transaction(async (tx) => {
        const u = await createUser(tx, {
          orgId: p.org.id,
          email: body.email,
          name: body.name,
          role: body.role,
          status: 'invited',
          inviteTokenHash: sha256Hex(secret),
          inviteExpiresAt,
          roleGrantedBy: p.user.id,
        });
        if (seatTier) await createSeat(tx, { orgId: p.org.id, userId: u.id, tier: seatTier });
        await writeAudit(ctx, tx, p.org, {
          actor: userActor(p.user),
          action: 'user.invited',
          data: { userId: u.id, emailHash: piiHash(p.org, body.email.trim().toLowerCase()), role: body.role, tier: seatTier },
        });
        return u;
      });
    } catch (err) {
      if (isUniqueViolation(err)) fail('email_taken', 'an account with this email exists');
      throw err;
    }
    req.log.info({ invitedUserId: user.id }, 'user invited');
    // Rule 4.2a: the mail goes after the commit; a send failure never fails the invite.
    let mailed = false;
    if (shouldMailInvite(ctx, body.sendEmail)) ({ mailed, user } = await mailInvite(ctx, p.org, p.user, user, secret, inviteExpiresAt));
    return reply.status(201).send({ user: toUser(user), inviteUrl: inviteUrlOf(ctx, secret), mailed });
  });

  // Rule 4.2c: a new secret (the old link stops working), a new 7-day expiry, the mail when available.
  app.post<{ Params: { id: string } }>('/api/v1/users/:id/invite/resend', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const target = await orgUser(ctx, p.org, req.params.id);
    if (target.status !== 'invited') fail('bad_state', 'only an invited user can be sent the invitation again');
    await limitHour(ctx, `invite-resend-user:${target.id}`, RESEND_PER_USER_HOUR);
    await limitHour(ctx, `invite-resend-org:${p.org.id}`, RESEND_PER_ORG_HOUR);
    const secret = randomSecret(32);
    const inviteExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
    let user = await ctx.db.transaction(async (tx) => {
      const u = await updateUser(tx, target.id, { inviteTokenHash: sha256Hex(secret), inviteExpiresAt });
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'user.invite_resent', data: { userId: target.id } });
      return u;
    });
    let mailed = false;
    if (mailAvailable(ctx)) ({ mailed, user } = await mailInvite(ctx, p.org, p.user, user, secret, inviteExpiresAt));
    req.log.info({ invitedUserId: user.id, mailed }, 'invitation renewed');
    return { inviteUrl: inviteUrlOf(ctx, secret), mailed, inviteExpiresAt: inviteExpiresAt.toISOString() };
  });

  app.patch<{ Params: { id: string } }>('/api/v1/users/:id/role', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(roleChangeRequestSchema, req.body);
    const target = await orgUser(ctx, p.org, req.params.id);
    await assertNoOpenErasure(ctx, p.org, { kind: 'role', userId: target.id, from: target.role, to: body.role });
    if (target.role === 'org_admin' && body.role !== 'org_admin' && target.status === 'active') {
      if ((await countOrgAdmins(ctx.db, p.org.id, 'active')) <= 1) fail('last_org_admin', 'the org needs an admin');
    }
    const demotesBreakGlass = target.ssoBreakGlass && body.role !== 'org_admin';
    if (demotesBreakGlass) await guardLastBreakGlass(ctx, p.org, target);
    const seat = await getSeatByUser(ctx.db, target.id);
    const toTier: PackageTier | null = roleHasSeat(body.role) ? (body.tier ?? seat?.tier ?? 'p1_browser') : null;
    if (toTier) checkTier(p.org, toTier);
    const updated = await ctx.db.transaction(async (tx) => {
      const u = await updateUser(tx, target.id, {
        role: body.role,
        ...(body.role !== target.role ? { roleSince: new Date(), roleGrantedBy: p.user.id } : {}),
      });
      // Rule 3.7e: break-glass is an org_admin flag; a demotion clears it in the same transaction.
      if (demotesBreakGlass) await clearBreakGlass(tx, target.id);
      if (toTier && seat) await updateSeat(tx, target.id, { tier: toTier });
      else if (toTier) await createSeat(tx, { orgId: p.org.id, userId: target.id, tier: toTier });
      else if (seat) await deleteSeatByUser(tx, target.id);
      await writeAudit(ctx, tx, p.org, {
        actor: userActor(p.user),
        action: 'user.role_changed',
        data: { userId: target.id, from: target.role, to: body.role, fromTier: seat?.tier ?? null, toTier },
      });
      return u;
    });
    // Live sockets of the user pick up the new role now: a role without "WS as Assist" is closed 4403 and
    // `canAct` on the next knock follows the new role (section 7.2, SEC-02).
    await ctx.hub.refreshUser(target.id);
    return toUser(updated);
  });

  app.patch<{ Params: { id: string } }>('/api/v1/users/:id/status', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(statusChangeRequestSchema, req.body);
    const target = await orgUser(ctx, p.org, req.params.id);
    if (target.status === body.status) return toUser(target);
    await assertNoOpenErasure(ctx, p.org, { kind: 'status', userId: target.id, role: target.role, from: target.status, to: body.status });
    if (body.status === 'disabled' && target.role === 'org_admin' && target.status === 'active') {
      if ((await countOrgAdmins(ctx.db, p.org.id, 'active')) <= 1) fail('last_org_admin', 'the org needs an admin');
    }
    const disablesBreakGlass = body.status === 'disabled' && target.ssoBreakGlass;
    if (disablesBreakGlass) await guardLastBreakGlass(ctx, p.org, target);
    const actor = userActor(p.user);
    const revokedTokenIds: string[] = [];
    const updated = await ctx.db.transaction(async (tx) => {
      const u = await updateUser(tx, target.id, { status: body.status });
      // A disabled user cannot be a break-glass administrator (rule 3.7a requires every one active).
      if (disablesBreakGlass) await clearBreakGlass(tx, target.id);
      let revokedSessions = 0;
      if (body.status === 'disabled') {
        revokedSessions = await revokeUserAuthSessions(tx, target.id);
        // Lock every token row first: row locks before the audit advisory lock (correctness-F1 lock order).
        for (const t of await listActiveTokensByCreator(tx, target.id, { forUpdate: true })) {
          const r = await revokeTokenRow(ctx, tx, t.id, 'user_disabled', actor);
          if (r?.changed) revokedTokenIds.push(t.id);
        }
      }
      await writeAudit(ctx, tx, p.org, {
        actor,
        action: 'user.status_changed',
        data: { userId: target.id, from: target.status, to: body.status, revokedSessions, revokedTokens: revokedTokenIds.length },
      });
      return u;
    });
    if (body.status === 'disabled') {
      ctx.hub.closeUserSockets(target.id, WS_CLOSE.unauthenticated);
      for (const id of revokedTokenIds) await afterTokenRevoked(ctx, id, actor);
    }
    return toUser(updated);
  });
}
