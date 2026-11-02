/**
 * Cookie sessions (contracts section 6.1): `ia_session` carries `sign(v)` (@fastify/cookie, SESSION_COOKIE_SECRET);
 * the database stores `sha256Hex(v)`. `authenticate()` resolves the principal once per request and enforces the
 * defence-in-depth region assertion of rule R3 (`org.data_region` must be served by this node, else 421).
 */
import cookie from '@fastify/cookie';
import {
  isRegionServed,
  sha256Hex,
  SESSION_COOKIE_NAME,
  type LoginMethod,
  type UserRole,
} from '@indiansassist/shared';
import {
  createAuthSession,
  findValidAuthSession,
  findValidAuthSessionById,
  getOrg,
  getSeatByUser,
  touchAuthSession,
  type AuthSessionRow,
  type Executor,
  type OrgRow,
  type TechnicianSeatRow,
  type UserRow,
} from '@indiansassist/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, HttpError } from '../errors.js';
import { randomSecret, safeEqual } from '../lib/crypto.js';
import { requireRole } from '../lib/rbac.js';

export type Principal = { user: UserRow; org: OrgRow; seat: TechnicianSeatRow | null; authSession: AuthSessionRow };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null | undefined;
  }
}

export const COOKIE_MAX_AGE_SEC = 604800;

export async function registerAuth(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(cookie, { secret: ctx.config.sessionCookieSecret, hook: 'onRequest' });
  app.decorateRequest('principal', undefined);
}

/** The raw cookie value `v` from a signed cookie string, or null when missing or badly signed. */
export function unsignSessionCookie(app: FastifyInstance, signed: string | undefined): string | null {
  if (!signed) return null;
  const res = app.unsignCookie(signed);
  return res.valid && res.value ? res.value : null;
}

/** Looks up a raw cookie value; null when unknown, expired, revoked or the user is not active. */
export async function principalFromCookieValue(ctx: AppContext, raw: string | null): Promise<Principal | null> {
  if (!raw) return null;
  const hash = sha256Hex(raw);
  const found = await findValidAuthSession(ctx.db, hash);
  if (!found || !safeEqual(found.session.tokenHash, hash)) return null;
  if (found.user.status !== 'active') return null;
  const org = await getOrg(ctx.db, found.user.orgId);
  if (!org) return null;
  const seat = await getSeatByUser(ctx.db, found.user.id);
  return { user: found.user, org, seat, authSession: found.session };
}

/**
 * The principal of a cookie session by its id (not revoked, not expired, user active). Used by a session's owner
 * node for an Assist socket held by another node, which forwards only the cookie session id (section 7.6 N1).
 */
export async function principalFromAuthSessionId(ctx: AppContext, authSessionId: string): Promise<Principal | null> {
  const found = await findValidAuthSessionById(ctx.db, authSessionId);
  if (!found || found.user.status !== 'active') return null;
  const org = await getOrg(ctx.db, found.user.orgId);
  if (!org) return null;
  const seat = await getSeatByUser(ctx.db, found.user.id);
  return { user: found.user, org, seat, authSession: found.session };
}

export function assertOrgServed(ctx: AppContext, org: OrgRow, log: { error: (o: object, m: string) => void }): void {
  if (!isRegionServed(org.dataRegion, ctx.config.servedRegions)) {
    log.error({ orgId: org.id, region: org.dataRegion }, 'authenticated org region is not served by this node');
    fail('region_mismatch', 'this organisation is not served by this node', {
      region: org.dataRegion,
      origin: ctx.config.regionOrigins[org.dataRegion] ?? null,
    });
  }
}

/** Resolves the caller (401 unauthenticated otherwise) and checks `roles` when given (403 forbidden). */
export async function authenticate(
  ctx: AppContext,
  req: FastifyRequest,
  roles?: readonly UserRole[],
): Promise<Principal> {
  if (req.principal === undefined) {
    const raw = unsignSessionCookie(req.server, req.cookies[SESSION_COOKIE_NAME]);
    req.principal = await principalFromCookieValue(ctx, raw);
    if (req.principal) {
      assertOrgServed(ctx, req.principal.org, req.log);
      await touchAuthSession(ctx.db, req.principal.authSession.id).catch(() => false);
    }
  }
  const p = req.principal;
  if (!p) throw new HttpError('unauthenticated', 'sign in required');
  if (roles) requireRole(p.user.role, roles);
  return p;
}

/**
 * Mints a new auth_session and cookie (session fixation rule: always a new row and value). Runs inside the
 * caller's transaction; the cookie is set by `setSessionCookie` after commit. Phase E section 3.8: `loginMethod` is
 * written on every mint, and `expiresAt` shortens the 7-day default (SSO `sessionMaxAgeHours`, break-glass 1 h).
 */
export async function mintSession(
  exec: Executor,
  req: FastifyRequest,
  user: UserRow,
  org: OrgRow,
  opts: { loginMethod?: LoginMethod; expiresAt?: Date } = {},
): Promise<{ raw: string; row: AuthSessionRow }> {
  const raw = randomSecret(32);
  const row = await createAuthSession(exec, {
    userId: user.id,
    tokenHash: sha256Hex(raw),
    region: org.dataRegion,
    userAgent: (req.headers['user-agent'] ?? '').slice(0, 512) || null,
    ip: req.ip ?? null,
    ...(opts.loginMethod ? { loginMethod: opts.loginMethod } : {}),
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  });
  return { raw, row };
}

/** Sets `ia_session`; `maxAgeSec` (Phase E section 3.8) matches a shortened session, default 7 days. */
export function setSessionCookie(ctx: AppContext, reply: FastifyReply, raw: string, maxAgeSec: number = COOKIE_MAX_AGE_SEC): void {
  void reply.setCookie(SESSION_COOKIE_NAME, raw, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSec,
    secure: ctx.config.production,
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.production,
  });
}
