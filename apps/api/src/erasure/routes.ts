/**
 * Phase F stream erasure (docs/specs/phase-f-contracts.md sections 5.1, 5.2, 5.6): the org erasure routes and the
 * public certificate and chain-digest routes. Registered through `PHASE_F_ROUTE_PLUGINS` in app.ts.
 *
 *   GET  /api/v1/orgs/current/erasure                    every role ({ erasure } for org_admin and auditor, else { notice })
 *   POST /api/v1/orgs/current/erasure                    org_admin, fresh sign-in, typed slug (5.2a); solo path 5.2f
 *   POST /api/v1/orgs/current/erasure/:id/confirm        the requester of a solo erasure (the mailed token)
 *   POST /api/v1/orgs/current/erasure/:id/approve        an eligible second org_admin (5.2b), fresh sign-in, typed slug
 *   POST /api/v1/orgs/current/erasure/:id/cancel         any org_admin; never rate limited (section 2.3)
 *   GET  /api/v1/erasures/:id/certificate                public by unguessable id, 404 until completed
 *   GET  /api/v1/erasures/:id/chain-digest               public by unguessable id, 404 until completed
 *
 * The reason is stored in the row (scrubbed at step 5) and never chained; the certificate and the digest carry no
 * name, slug, email, reason or entry material.
 */
import {
  base64urlEncode,
  chainDigestQuerySchema,
  erasureApproveSchema,
  erasureConfirmSchema,
  erasureRequestSchema,
  LIMITS,
  randomBytes,
  sha256Hex,
  type ErasureNotice,
  type OrgErasure,
} from '@indiansassist/shared';
import {
  getErasure,
  getLatestErasure,
  getOpenErasure,
  getUser,
  insertErasure,
  isUniqueViolation,
  listChainDigest,
  transitionErasure,
  type OrgErasureRow,
} from '@indiansassist/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { safeEqual } from '../lib/crypto.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { UUID_RE } from '../services/scope.js';
import {
  adminsAndAuditors,
  coolingOffUntil,
  eligibleApprovers,
  erasurePageUrl,
  freshlyAuthenticated,
  isEligibleApprover,
  mailEach,
  requestMail,
  scheduledMail,
  soloAvailable,
  soloConfirmMail,
  toOrgErasure,
} from './model.js';

const HOUR_MS = 3_600_000;
const CANCELLABLE = ['pending_confirmation', 'pending_approval', 'cooling_off'] as const;

async function rateLimit(ctx: AppContext, key: string, limit: number, windowMs: number): Promise<void> {
  const lim = await ctx.limiter.hit(key, limit, windowMs);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    fail('rate_limited', 'too many erasure requests', { retryAfterSec: lim.retryAfterSec });
  }
}

function requireFreshSignIn(p: Principal): void {
  if (!freshlyAuthenticated(p.authSession))
    fail('reauth_required', `sign in again: erasure needs a sign-in from the last ${LIMITS.erasureReauthMin} minutes`, { maxAgeMin: LIMITS.erasureReauthMin });
}

function requireSlug(p: Principal, confirmSlug: string): void {
  if (confirmSlug !== p.org.slug) fail('erasure_confirm_mismatch', 'the typed slug does not match this organisation');
}

/** The org's erasure by id (cross-org and unknown ids are `404`). */
async function orgErasureOr404(ctx: AppContext, p: Principal, id: string): Promise<OrgErasureRow> {
  if (!UUID_RE.test(id)) fail('not_found', 'erasure not found');
  const row = await getErasure(ctx.db, id);
  if (!row || row.orgId !== p.org.id) fail('not_found', 'erasure not found');
  return row;
}

function noticeOf(e: OrgErasure | null): ErasureNotice | null {
  return e ? { state: e.state, coolingOffUntil: e.coolingOffUntil, certificateUrl: e.certificateUrl } : null;
}

/** The 32-byte single-use confirmation token of the solo path (base64url, 43 characters). */
function mintConfirmToken(): string {
  return base64urlEncode(randomBytes(32));
}

export async function erasureRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const reply = async (row: OrgErasureRow) => toOrgErasure(ctx, ctx.db, row);

  app.get('/api/v1/orgs/current/erasure', async (req) => {
    const p = await authenticate(ctx, req);
    if (p.user.role === 'org_admin' || p.user.role === 'auditor') {
      const row = (await getOpenErasure(ctx.db, p.org.id)) ?? (await getLatestErasure(ctx.db, p.org.id));
      return { erasure: row ? await reply(row) : null };
    }
    // Every other role reads the banner's notice of an open erasure only: no names.
    const open = await getOpenErasure(ctx.db, p.org.id);
    return { notice: noticeOf(open ? await reply(open) : null) };
  });

  app.post('/api/v1/orgs/current/erasure', async (req: FastifyRequest, res) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    await rateLimit(ctx, `erasure-request:${p.org.id}`, 5, HOUR_MS);
    const body = parseOr400(erasureRequestSchema, req.body);
    requireFreshSignIn(p);
    requireSlug(p, body.confirmSlug);
    if (await getOpenErasure(ctx.db, p.org.id)) fail('erasure_exists', 'an erasure of this organisation is already open');
    const solo = body.solo === true;
    const approvers = await eligibleApprovers(ctx, ctx.db, p.org.id, p.user.id);
    if (solo) {
      if (approvers.length > 0) fail('bad_state', 'this organisation has a second administrator who can approve; request without the single-admin path');
      if (!(await soloAvailable(ctx, ctx.db, p.org)))
        fail('erasure_second_admin', 'the single-admin path needs exactly one administrator and no administrator demoted or disabled in the last 7 days', {
          soloAvailable: false,
        });
    } else if (approvers.length === 0) {
      fail('erasure_second_admin', 'an erasure needs a second administrator of at least 7 days who you did not invite or promote', {
        soloAvailable: await soloAvailable(ctx, ctx.db, p.org),
      });
    }
    const token = solo ? mintConfirmToken() : null;
    const now = new Date();
    let row: OrgErasureRow;
    try {
      row = await ctx.db.transaction(async (tx) => {
        const r = await insertErasure(tx, {
          orgId: p.org.id,
          state: solo ? 'pending_confirmation' : 'pending_approval',
          solo,
          confirmTokenHash: token ? sha256Hex(token) : null,
          confirmExpiresAt: token ? new Date(now.getTime() + LIMITS.erasureConfirmTtlHours * HOUR_MS) : null,
          reason: body.reason ?? null,
          requestedBy: p.user.id,
          requestedAt: now,
        });
        // The reason stays in the row (scrubbed at step 5); it is never chained (section 2.2).
        await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'org.erasure_requested', data: { erasureId: r.id, solo } });
        return r;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'org_erasure_open_unique')) fail('erasure_exists', 'an erasure of this organisation is already open');
      throw err;
    }
    // Rule 5.2d: every active org_admin and auditor is told at request time (smtp only).
    const people = await adminsAndAuditors(ctx.db, p.org.id);
    const notice = requestMail(ctx, p.org, p.user, row);
    const confirmUrl = token ? `${erasurePageUrl(ctx)}#confirm=${token}` : null;
    if (solo && confirmUrl) {
      const m = soloConfirmMail(ctx, p.org, confirmUrl);
      await mailEach(ctx, [p.user.email], m.subject, m.text);
      await mailEach(ctx, people.filter((u) => u.id !== p.user.id).map((u) => u.email), notice.subject, notice.text);
    } else {
      await mailEach(ctx, people.map((u) => u.email), notice.subject, notice.text);
    }
    // With the `log` driver the confirmation link is shown once, in this reply, and never again (5.2f).
    const out: { erasure: OrgErasure; confirmUrl?: string } = { erasure: await reply(row) };
    if (confirmUrl && ctx.mailer.driver !== 'smtp') out.confirmUrl = confirmUrl;
    return res.status(201).send(out);
  });

  app.post<{ Params: { id: string } }>('/api/v1/orgs/current/erasure/:id/confirm', async (req) => {
    const p = await authenticate(ctx, req);
    const row = await orgErasureOr404(ctx, p, req.params.id);
    if (!row.solo || row.requestedBy !== p.user.id) fail('forbidden', 'only the administrator who asked for this erasure can confirm it');
    const body = parseOr400(erasureConfirmSchema, req.body);
    requireFreshSignIn(p);
    const now = new Date();
    if (!row.confirmTokenHash || !safeEqual(row.confirmTokenHash, sha256Hex(body.token)) || !row.confirmExpiresAt || row.confirmExpiresAt <= now)
      fail('erasure_confirm_invalid', 'this confirmation link is unknown, used or expired');
    if (row.state !== 'pending_confirmation') fail('bad_state', `the erasure is ${row.state}`);
    const until = coolingOffUntil(ctx, now, true);
    const updated = await ctx.db.transaction(async (tx) => {
      const r = await transitionErasure(tx, row.id, 'pending_confirmation', 'cooling_off', {
        approvedAt: now,
        coolingOffUntil: until,
        confirmTokenHash: null,
        confirmExpiresAt: null,
      });
      if (!r) fail('bad_state', 'the erasure changed meanwhile');
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'org.erasure_confirmed', data: { erasureId: r.id, coolingOffUntil: until.toISOString() } });
      return r;
    });
    const m = scheduledMail(ctx, p.org, p.user, null, updated);
    await mailEach(ctx, (await adminsAndAuditors(ctx.db, p.org.id)).map((u) => u.email), m.subject, m.text);
    return { erasure: await reply(updated) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/orgs/current/erasure/:id/approve', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    await rateLimit(ctx, `erasure-approve:${p.org.id}`, 5, HOUR_MS);
    const row = await orgErasureOr404(ctx, p, req.params.id);
    const body = parseOr400(erasureApproveSchema, req.body);
    requireFreshSignIn(p);
    requireSlug(p, body.confirmSlug);
    if (row.state !== 'pending_approval') fail('bad_state', `the erasure is ${row.state}`);
    if (!isEligibleApprover(ctx, p.user, row.requestedBy))
      fail(
        'erasure_second_admin',
        p.user.id === row.requestedBy
          ? 'the administrator who asked for the erasure cannot approve it'
          : 'an approver must have been an administrator for at least 7 days and not invited or promoted by the requester',
      );
    const now = new Date();
    const until = coolingOffUntil(ctx, now, false);
    const updated = await ctx.db.transaction(async (tx) => {
      const r = await transitionErasure(tx, row.id, 'pending_approval', 'cooling_off', { approvedBy: p.user.id, approvedAt: now, coolingOffUntil: until });
      if (!r) fail('bad_state', 'the erasure changed meanwhile');
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'org.erasure_approved', data: { erasureId: r.id, coolingOffUntil: until.toISOString() } });
      return r;
    });
    const requester = await getUser(ctx.db, row.requestedBy);
    if (requester) {
      const m = scheduledMail(ctx, p.org, requester, p.user, updated);
      await mailEach(ctx, (await adminsAndAuditors(ctx.db, p.org.id)).map((u) => u.email), m.subject, m.text);
    }
    return { erasure: await reply(updated) };
  });

  // Section 2.3: never rate limited, no fresh sign-in and no slug: cancelling must always be easy.
  app.post<{ Params: { id: string } }>('/api/v1/orgs/current/erasure/:id/cancel', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin']);
    const row = await orgErasureOr404(ctx, p, req.params.id);
    if (!(CANCELLABLE as readonly string[]).includes(row.state)) fail('erasure_not_cancellable', `the erasure is ${row.state}`);
    const fromState = row.state as (typeof CANCELLABLE)[number];
    const updated = await ctx.db.transaction(async (tx) => {
      const r = await transitionErasure(tx, row.id, CANCELLABLE, 'cancelled', {
        cancelledBy: p.user.id,
        cancelledAt: new Date(),
        confirmTokenHash: null,
        confirmExpiresAt: null,
      });
      if (!r) fail('erasure_not_cancellable', 'the erasure started or ended meanwhile');
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'org.erasure_cancelled', data: { erasureId: r.id, fromState } });
      return r;
    });
    return { erasure: await reply(updated) };
  });

  // ---------- public by unguessable id (section 5.6) ----------

  const completedOr404 = async (id: string): Promise<OrgErasureRow> => {
    if (!UUID_RE.test(id)) fail('not_found', 'erasure certificate not found');
    const row = await getErasure(ctx.db, id);
    if (!row || row.state !== 'completed' || !row.certificate) fail('not_found', 'erasure certificate not found');
    return row;
  };

  app.get<{ Params: { id: string } }>('/api/v1/erasures/:id/certificate', async (req, res) => {
    await rateLimit(ctx, `erasure-certificate-ip:${req.ip}`, 30, 60_000);
    const row = await completedOr404(req.params.id);
    return res.header('cache-control', 'no-store').type('application/json; charset=utf-8').send(JSON.stringify(row.certificate));
  });

  app.get<{ Params: { id: string } }>('/api/v1/erasures/:id/chain-digest', async (req, res) => {
    await rateLimit(ctx, `erasure-digest-ip:${req.ip}`, 30, 60_000);
    const q = parseOr400(chainDigestQuerySchema, req.query);
    const row = await completedOr404(req.params.id);
    const limit = q.limit ?? 1000;
    const items = await listChainDigest(ctx.db, row.orgId, q.after ?? 0, limit);
    const last = items[items.length - 1];
    return res.header('cache-control', 'no-store').send({ items, nextAfter: items.length === limit && last ? last.seq : null });
  });
}
