/**
 * Auth routes (contracts sections 6.1, 6.5): signup (org with immutable region + org_admin + p1 seat), login with
 * lockout, logout, me, accept-invite and password change. Every success mints a new auth_session (fixation rule).
 */
import {
  acceptInviteRequestSchema,
  changePasswordRequestSchema,
  isRegionServed,
  LIMITS,
  loginRequestSchema,
  sha256Hex,
  signupRequestSchema,
} from '@indiansassist/shared';
import {
  countLoginFailuresSince,
  createOrg,
  createSeat,
  createUser,
  findUserByEmail,
  findUserByInviteHash,
  getOrg,
  getSeatByUser,
  isSlugTaken,
  isUniqueViolation,
  recordLoginAttempt,
  revokeAuthSession,
  revokeUserAuthSessions,
  updateUser,
  type OrgRow,
  type TechnicianSeatRow,
  type UserRow,
} from '@indiansassist/db';
import { WS_CLOSE } from '@indiansassist/shared';
import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPasswordHash } from '../adapters/auth-provider.js';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { piiHash, systemActor, userActor, writeAudit } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';
import { toOrg, toSeat, toUser } from '../lib/mappers.js';
import { parseOr400 } from '../lib/validate.js';
import {
  assertOrgServed,
  authenticate,
  clearSessionCookie,
  mintSession,
  setSessionCookie,
} from '../plugins/auth.js';
import { limits } from '../plugins/security.js';
import { planHasPlaybooks, seedStarterPlaybooks } from '../services/playbook-seed.js';
import { notifyBreakGlassLogin } from '../sso/break-glass.js';
import { beginPath } from '../sso/urls.js';

const LOCKOUT_WINDOW_MS = 15 * 60_000;
const LOCKOUT_FAILURES = 10;

/** Slug from an org name: lower-case `[a-z0-9-]`, 3..40 chars. */
export function slugify(name: string): string {
  let s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
    .replace(/-+$/g, '');
  if (s.length < 3) s = `org-${s}`.replace(/-+$/g, '').padEnd(3, '0');
  return s;
}

function authBody(user: UserRow, org: OrgRow, seat: TechnicianSeatRow | null) {
  return { user: toUser(user), org: toOrg(org), seat: toSeat(seat) };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/auth/signup', { config: limits.auth }, async (req, reply) => {
    const body = parseOr400(signupRequestSchema, req.body);
    const region = body.region ?? ctx.config.defaultRegion;
    if (!isRegionServed(region, ctx.config.servedRegions))
      fail('region_mismatch', 'this region is served by another site', {
        region,
        origin: ctx.config.regionOrigins[region] ?? null,
      });
    if (await findUserByEmail(ctx.db, body.email)) fail('email_taken', 'an account with this email exists');
    let slug = body.slug;
    if (slug !== undefined) {
      if (await isSlugTaken(ctx.db, slug)) fail('slug_taken', 'this slug is taken');
    } else {
      const base = slugify(body.orgName);
      slug = base;
      for (let i = 2; await isSlugTaken(ctx.db, slug); i++) slug = `${base}-${i}`;
    }
    const passwordHash = await hashPassword(body.password);
    try {
      const out = await ctx.db.transaction(async (tx) => {
        const org = await createOrg(tx, {
          name: body.orgName,
          slug: slug!,
          dataRegion: region,
          planTier: ctx.config.signupPlanTier,
        });
        const user = await createUser(tx, {
          orgId: org.id,
          email: body.email,
          name: body.name,
          role: 'org_admin',
          status: 'active',
          passwordHash,
        });
        const seat = await createSeat(tx, { orgId: org.id, userId: user.id, tier: 'p1_browser' });
        await writeAudit(ctx, tx, org, {
          actor: userActor(user),
          action: 'auth.signup',
          data: { emailHash: piiHash(org, body.email.trim().toLowerCase()) },
        });
        // Phase C section 8.6: an org whose plan includes P3 starts with the starter playbooks.
        if (planHasPlaybooks(org.planTier)) await seedStarterPlaybooks(ctx, tx, org, user.id);
        const minted = await mintSession(tx, req, user, org, { loginMethod: 'local' });
        return { org, user, seat, raw: minted.raw };
      });
      setSessionCookie(ctx, reply, out.raw);
      return reply.status(201).send(authBody(out.user, out.org, out.seat));
    } catch (err) {
      if (isUniqueViolation(err, 'org_slug_unique')) fail('slug_taken', 'this slug is taken');
      if (isUniqueViolation(err, 'user_email_lower_unique')) fail('email_taken', 'an account with this email exists');
      throw err;
    }
  });

  app.post('/api/v1/auth/login', { config: limits.auth }, async (req, reply) => {
    const body = parseOr400(loginRequestSchema, req.body);
    const emailHash = sha256Hex(body.email.trim().toLowerCase());
    const failures = await countLoginFailuresSince(ctx.db, emailHash, new Date(Date.now() - LOCKOUT_WINDOW_MS));
    if (failures >= LOCKOUT_FAILURES)
      fail('rate_limited', 'too many failed attempts, try again later', { retryAfterSec: LOCKOUT_WINDOW_MS / 1000 });
    const user = await findUserByEmail(ctx.db, body.email);
    const passwordOk = await verifyPasswordHash(user?.passwordHash ?? null, body.password);
    const org = user ? await getOrg(ctx.db, user.orgId) : null;
    if (!user || !org || !passwordOk || user.status !== 'active') {
      await recordLoginAttempt(ctx.db, { emailHash, ip: req.ip, success: false });
      if (user && org)
        await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'auth.login_failed', data: { userId: user.id } });
      fail('invalid_credentials', 'email or password is wrong');
    }
    assertOrgServed(ctx, org, req.log);
    // Phase E rule 3.7b: only after the password is verified, so a wrong one still answers 401 and counts.
    if (org.ssoRequired && !user.ssoBreakGlass)
      fail('sso_required', 'your organisation signs in with single sign-on', { beginUrl: beginPath(org.slug, { loginHint: user.email }) });
    // Rule 3.7d: a break-glass password login while SSO is required gets a 1 h session, is chained and mailed.
    const breakGlass = org.ssoRequired && user.ssoBreakGlass;
    const bgSec = LIMITS.breakGlassSessionHours * 3600;
    const out = await ctx.db.transaction(async (tx) => {
      await recordLoginAttempt(tx, { emailHash, ip: req.ip, success: true });
      const updated = await updateUser(tx, user.id, { lastLoginAt: new Date() });
      await writeAudit(ctx, tx, org, { actor: userActor(updated), action: 'auth.login', data: { method: 'local' } });
      if (breakGlass)
        await writeAudit(ctx, tx, org, { actor: userActor(updated), action: 'auth.break_glass_used', data: { userId: updated.id } });
      const minted = await mintSession(tx, req, updated, org, {
        loginMethod: 'local',
        ...(breakGlass ? { expiresAt: new Date(Date.now() + bgSec * 1000) } : {}),
      });
      return { user: updated, raw: minted.raw };
    });
    setSessionCookie(ctx, reply, out.raw, breakGlass ? bgSec : undefined);
    if (breakGlass) void notifyBreakGlassLogin(ctx, org, out.user, req.ip);
    return authBody(out.user, org, await getSeatByUser(ctx.db, user.id));
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const p = await authenticate(ctx, req);
    await ctx.db.transaction(async (tx) => {
      await revokeAuthSession(tx, p.authSession.id);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'auth.logout' });
    });
    // Live consoles opened with this cookie lose their authority with it (section 7.2, SEC-02).
    ctx.hub.closeSocketsForAuthSessions([p.authSession.id], WS_CLOSE.unauthenticated);
    clearSessionCookie(ctx, reply);
    return reply.status(204).send();
  });

  app.get('/api/v1/auth/me', async (req) => {
    const p = await authenticate(ctx, req);
    return authBody(p.user, p.org, p.seat);
  });

  app.post('/api/v1/auth/accept-invite', { config: limits.auth }, async (req, reply) => {
    const body = parseOr400(acceptInviteRequestSchema, req.body);
    const hash = sha256Hex(body.invite);
    const user = await findUserByInviteHash(ctx.db, hash);
    const valid =
      user !== null &&
      safeEqual(user.inviteTokenHash, hash) &&
      user.status === 'invited' &&
      user.inviteExpiresAt !== null &&
      user.inviteExpiresAt.getTime() > Date.now();
    if (!valid || !user) fail('invite_invalid', 'this invite is not valid');
    const org = await getOrg(ctx.db, user.orgId);
    if (!org) fail('invite_invalid', 'this invite is not valid');
    assertOrgServed(ctx, org, req.log);
    // Phase E rule 3.7b: the invitee signs in with SSO, which activates them (section 3.6 rule 2).
    if (org.ssoRequired) fail('sso_required', 'your organisation signs in with single sign-on', { beginUrl: beginPath(org.slug, { loginHint: user.email }) });
    const passwordHash = await hashPassword(body.password);
    const out = await ctx.db.transaction(async (tx) => {
      const updated = await updateUser(tx, user.id, {
        passwordHash,
        name: body.name,
        status: 'active',
        inviteTokenHash: null,
        inviteExpiresAt: null,
        lastLoginAt: new Date(),
      });
      await writeAudit(ctx, tx, org, { actor: userActor(updated), action: 'auth.login', data: { method: 'invite' } });
      const minted = await mintSession(tx, req, updated, org, { loginMethod: 'invite' });
      return { user: updated, raw: minted.raw };
    });
    setSessionCookie(ctx, reply, out.raw);
    return authBody(out.user, org, await getSeatByUser(ctx.db, user.id));
  });

  app.post('/api/v1/auth/password', { config: limits.auth }, async (req, reply) => {
    const p = await authenticate(ctx, req);
    // Phase E rule 3.7b: no password changes for SSO-required users other than break-glass administrators.
    if (p.org.ssoRequired && !p.user.ssoBreakGlass) fail('sso_required', 'your organisation signs in with single sign-on');
    const body = parseOr400(changePasswordRequestSchema, req.body);
    if (!(await verifyPasswordHash(p.user.passwordHash, body.currentPassword)))
      fail('reauth_required', 'current password is wrong');
    const passwordHash = await hashPassword(body.newPassword);
    await ctx.db.transaction(async (tx) => {
      await updateUser(tx, p.user.id, { passwordHash });
      await revokeUserAuthSessions(tx, p.user.id, p.authSession.id);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'auth.password_changed' });
    });
    // Every other cookie session was revoked, so are the sockets opened with them (SEC-02).
    ctx.hub.closeUserSockets(p.user.id, WS_CLOSE.unauthenticated, { exceptAuthSessionId: p.authSession.id });
    return reply.status(204).send();
  });
}
