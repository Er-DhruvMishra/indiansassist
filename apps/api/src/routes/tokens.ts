/**
 * Token routes (contracts sections 3, 6.7): create (Ed25519 signed compact token, seat tier cap), list / get with
 * the effective status, revoke (idempotent, cascades to live sessions) and the public lookup by compact token or
 * 12-digit short code.
 */
import { randomUUID } from 'node:crypto';
import {
  createTokenRequestSchema,
  publicLookupRequestSchema,
  signToken,
  tierWithin,
  tokenLifetimeSeconds,
  tokensListQuerySchema,
  tokenTypeAllowedForTier,
  type PublicToken,
} from '@indiansassist/shared';
import {
  findTokenByTid,
  getSeatByUser,
  insertTokenWithShortCode,
  listTokensByOrg,
  type TokenRow,
} from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { brandingPublic, joinUrlOf, toToken } from '../lib/mappers.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { limits } from '../plugins/security.js';
import { revokeTokenAndCascade } from '../services/token-revoke.js';
import { verifyTokenInput } from '../services/token-verify.js';
import { wsOrigin } from './health.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Token in the caller's org and scope: cross-org 404, out of `own` scope 403 (section 2.3). */
async function scopedToken(ctx: AppContext, p: Principal, id: string, write: boolean): Promise<TokenRow> {
  const tok = UUID_RE.test(id) ? await findTokenByTid(ctx.db, id) : null;
  if (!tok || tok.orgId !== p.org.id) fail('not_found', 'token not found');
  if (p.user.role === 'technician' && tok.createdBy !== p.user.id) fail('forbidden', 'not your token');
  if (write && p.user.role === 'auditor') fail('forbidden', 'read-only role');
  return tok;
}

async function wireToken(ctx: AppContext, tok: TokenRow) {
  const names = await userRefs(ctx.db, [tok.createdBy]);
  return toToken(tok, refOf(names, tok.createdBy), ctx.config.webOrigin);
}

export async function tokenRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/tokens', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const body = parseOr400(createTokenRequestSchema, req.body);
    if (!tokenTypeAllowedForTier(body.typ, body.tier))
      fail('invalid_token_type', 'enrollment tokens are only valid for p4_installed');
    const seat = await getSeatByUser(ctx.db, p.user.id);
    if (!seat || !seat.active || !tierWithin(body.tier, seat.tier))
      fail('tier_not_licensed', `your seat does not include ${body.tier}`);
    const id = randomUUID();
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + tokenLifetimeSeconds(body);
    const signed = await signToken(
      { tid: id, org: p.org.id, by: p.user.id, tier: body.tier, typ: body.typ, reg: p.org.dataRegion, iat, exp },
      ctx.keys.seedHex,
    );
    const tok = await ctx.db.transaction(async (tx) => {
      const row = await insertTokenWithShortCode(tx, {
        id,
        orgId: p.org.id,
        createdBy: p.user.id,
        tier: body.tier,
        typ: body.typ,
        label: body.label && body.label.trim() !== '' ? body.label : null,
        region: p.org.dataRegion,
        kid: signed.kid,
        signature: signed.signature,
        nonce: signed.payload.nonce,
        issuedAt: new Date(iat * 1000),
        expiresAt: new Date(exp * 1000),
      });
      await writeAudit(ctx, tx, p.org, {
        actor: userActor(p.user),
        action: 'token.created',
        data: { tokenId: id, tier: body.tier, typ: body.typ, expiresAt: iso(row.expiresAt) },
      });
      return row;
    });
    const token = toToken(tok, { id: p.user.id, name: p.user.name }, ctx.config.webOrigin);
    return reply.status(201).send({ token, compact: signed.compact, joinUrl: joinUrlOf(ctx.config.webOrigin, signed.compact) });
  });

  app.get('/api/v1/tokens', async (req) => {
    const p = await authenticate(ctx, req, ['technician', 'senior_technician', 'org_admin', 'auditor']);
    const q = parseOr400(tokensListQuerySchema, req.query);
    const page = await listTokensByOrg(ctx.db, p.org.id, {
      limit: q.limit,
      cursor: q.cursor ?? null,
      ...(q.status ? { status: q.status } : {}),
      ...(p.user.role === 'technician' ? { createdBy: p.user.id } : {}),
    });
    const names = await userRefs(ctx.db, page.items.map((t) => t.createdBy));
    return {
      items: page.items.map((t) => toToken(t, refOf(names, t.createdBy), ctx.config.webOrigin, t.effectiveStatus)),
      nextCursor: page.nextCursor,
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/tokens/:id', async (req) => {
    const p = await authenticate(ctx, req, ['technician', 'senior_technician', 'org_admin', 'auditor']);
    return wireToken(ctx, await scopedToken(ctx, p, req.params.id, false));
  });

  app.post<{ Params: { id: string } }>('/api/v1/tokens/:id/revoke', async (req) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const tok = await scopedToken(ctx, p, req.params.id, true);
    const res = await revokeTokenAndCascade(ctx, tok.id, 'manual', userActor(p.user));
    return wireToken(ctx, res?.token ?? tok);
  });

  app.post('/api/v1/tokens/public-lookup', { config: limits.publicLookup }, async (req): Promise<PublicToken> => {
    const body = parseOr400(publicLookupRequestSchema, req.body);
    const v = await verifyTokenInput(ctx, body.code, { ip: req.ip });
    if (!v.ok) {
      if (v.code === 'rate_limited') ctx.metrics.rateLimited.inc();
      fail(v.code, v.message, v.details);
    }
    const tok = v.token;
    const branding = brandingPublic(v.org);
    const technician =
      v.via === 'compact' ? { name: refOf(await userRefs(ctx.db, [tok.createdBy]), tok.createdBy).name } : null;
    return {
      tokenId: tok.id,
      tier: tok.tier,
      typ: tok.typ,
      expiresAt: iso(tok.expiresAt),
      region: tok.region,
      org: { ...branding, supportEmail: v.org.branding?.supportEmail ?? null },
      technician,
      signalUrl: `${wsOrigin(ctx.config.apiOrigin)}/signal`,
      joinSupported: (tok.tier === 'p1_browser' || tok.tier === 'p2_extension') && tok.typ !== 'enrollment',
      // Phase B 11.3: install info for the join page and the extension (non-null for p2_extension only).
      extension: tok.tier === 'p2_extension' ? { ...ctx.config.extension, ids: [...ctx.config.extension.ids] } : null,
    };
  });
}
