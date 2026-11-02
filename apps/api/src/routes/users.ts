/**
 * User routes (contracts sections 2.4, 6.6): list, invite (seat with tier capped by org.plan_tier), role change
 * (seat created / updated / removed, last org_admin protected) and status change (disable cascades to cookie
 * sessions, tokens, their live sessions and the user's Assist sockets).
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

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    if (await findUserByEmail(ctx.db, body.email)) fail('email_taken', 'an account with this email exists');
    const secret = randomSecret(32);
    try {
      const user = await ctx.db.transaction(async (tx) => {
        const u = await createUser(tx, {
          orgId: p.org.id,
          email: body.email,
          name: body.name,
          role: body.role,
          status: 'invited',
          inviteTokenHash: sha256Hex(secret),
          inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
        });
        if (seatTier) await createSeat(tx, { orgId: p.org.id, userId: u.id, tier: seatTier });
        await writeAudit(ctx, tx, p.org, {
          actor: userActor(p.user),
          action: 'user.invited',
          data: { userId: u.id, emailHash: piiHash(p.org, body.email.trim().toLowerCase()), role: body.role, tier: seatTier },
        });
        return u;
      });
      req.log.info({ invitedUserId: user.id }, 'user invited');
      return reply.status(201).send({ user: toUser(user), inviteUrl: `${ctx.config.webOrigin}/invite#i=${secret}` });
    } catch (err) {
      if (isUniqueViolation(err)) fail('email_taken', 'an account with this email exists');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/v1/users/:id/role', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const body = parseOr400(roleChangeRequestSchema, req.body);
    const target = await orgUser(ctx, p.org, req.params.id);
    if (target.role === 'org_admin' && body.role !== 'org_admin' && target.status === 'active') {
      if ((await countOrgAdmins(ctx.db, p.org.id, 'active')) <= 1) fail('last_org_admin', 'the org needs an admin');
    }
    const demotesBreakGlass = target.ssoBreakGlass && body.role !== 'org_admin';
    if (demotesBreakGlass) await guardLastBreakGlass(ctx, p.org, target);
    const seat = await getSeatByUser(ctx.db, target.id);
    const toTier: PackageTier | null = roleHasSeat(body.role) ? (body.tier ?? seat?.tier ?? 'p1_browser') : null;
    if (toTier) checkTier(p.org, toTier);
    const updated = await ctx.db.transaction(async (tx) => {
      const u = await updateUser(tx, target.id, { role: body.role });
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
