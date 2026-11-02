/**
 * Phase E sections 3.4 O8, 3.5 S6, 3.6, 3.8, 3.9: what the OIDC callback and the SAML ACS do with a provider's
 * result. A failure chains `auth.sso_failed` on the flow's org and redirects to `/login?sso_error=<code>`; a success
 * resolves the account (rules 1-4), mints a session of the SSO lifetime and redirects to the flow's `returnTo`. A test
 * flow (`POST /sso/test`) evaluates rules 1 and 2 read-only, stores `org.sso_last_test`, chains `sso.tested` and lands
 * on the settings page. Never a JSON error.
 */
import { parseSsoConfig, type SsoErrorCode, type SsoFlowRecord, type SsoProtocol } from '@indiansassist/shared';
import { getOrg, getUser, isUniqueViolation, updateUser, type OrgRow } from '@indiansassist/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { piiHash, systemActor, userActor, writeAudit } from '../lib/audit.js';
import { mintSession, setSessionCookie } from '../plugins/auth.js';
import type { SsoCompleteResult } from './provider.js';
import { updateOrgSso } from './repo.js';
import { evaluateTestLogin, resolveAccount } from './resolve.js';
import { loginErrorUrl, testResultUrl } from './urls.js';

const HOUR_MS = 3_600_000;

/** Section 3.8: `min(now + sessionMaxAgeHours, notOnOrAfter ?? infinity)`; at least one minute. */
export function ssoSessionExpiry(now: Date, maxAgeHours: number, notOnOrAfter: Date | null): Date {
  let t = now.getTime() + maxAgeHours * HOUR_MS;
  if (notOnOrAfter && notOnOrAfter.getTime() < t) t = notOnOrAfter.getTime();
  return new Date(Math.max(t, now.getTime() + 60_000));
}

async function chainFailure(ctx: AppContext, org: OrgRow, protocol: SsoProtocol, cause: SsoErrorCode, email: string | null): Promise<void> {
  await writeAudit(ctx, ctx.db, org, {
    actor: systemActor,
    action: 'auth.sso_failed',
    data: { protocol, cause, emailHash: email ? piiHash(org, email.trim().toLowerCase()) : null },
  }).catch((err: unknown) => ctx.log.error({ err }, 'auth.sso_failed could not be chained'));
}

async function finishTest(
  ctx: AppContext,
  reply: FastifyReply,
  org: OrgRow,
  flow: SsoFlowRecord,
  outcome: { ok: boolean; cause: SsoErrorCode | null; matchedSelf: boolean },
): Promise<FastifyReply> {
  const acting = flow.actingUserId ? await getUser(ctx.db, flow.actingUserId) : null;
  if (acting && acting.orgId === org.id) {
    await ctx.db.transaction(async (tx) => {
      await updateOrgSso(tx, org.id, {
        ssoLastTest: { at: new Date().toISOString(), ok: outcome.ok, cause: outcome.cause, userId: acting.id, matchedSelf: outcome.matchedSelf },
      });
      await writeAudit(ctx, tx, org, {
        actor: userActor(acting),
        action: 'sso.tested',
        data: { protocol: flow.protocol, ok: outcome.ok, cause: outcome.cause },
      });
    });
  }
  return reply.redirect(testResultUrl(ctx.config, outcome.ok ? 'ok' : (outcome.cause ?? 'invalid_response')), 303);
}

/** Turns a provider result into the redirect (and, on success, the session cookie). */
export async function finishSsoFlow(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  flow: SsoFlowRecord,
  result: SsoCompleteResult,
): Promise<FastifyReply> {
  const protocol = flow.protocol;
  if (!result.ok) {
    ctx.metrics.ssoLogins.inc({ protocol, result: result.cause });
    // binding_mismatch on another org's endpoint is chained on the flow's org: the one the flow was begun for.
    const org = result.orgId ? await getOrg(ctx.db, result.orgId) : null;
    if (org) await chainFailure(ctx, org, protocol, result.cause, result.email ?? null);
    if (flow.test && org && result.cause !== 'binding_mismatch')
      return finishTest(ctx, reply, org, flow, { ok: false, cause: result.cause, matchedSelf: false });
    return reply.redirect(loginErrorUrl(ctx.config, result.cause), 303);
  }
  const { org, assertion } = result;
  const cfg = parseSsoConfig(org.ssoConfig);
  if (!cfg) {
    ctx.metrics.ssoLogins.inc({ protocol, result: 'sso_disabled' });
    return reply.redirect(loginErrorUrl(ctx.config, 'sso_disabled'), 303);
  }
  if (flow.test) {
    const ev = await evaluateTestLogin(ctx.db, org, assertion, flow.actingUserId);
    ctx.metrics.ssoLogins.inc({ protocol, result: ev.ok ? 'ok' : (ev.cause ?? 'invalid_response') });
    if (!ev.ok && ev.cause) await chainFailure(ctx, org, protocol, ev.cause, assertion.email);
    return finishTest(ctx, reply, org, flow, ev);
  }
  let out: { ok: true; raw: string; maxAgeSec: number } | { ok: false; cause: SsoErrorCode };
  try {
    out = await ctx.db.transaction(async (tx) => {
      const r = await resolveAccount(ctx, tx, org, cfg, assertion);
      if (!r.ok) return { ok: false as const, cause: r.cause };
      const now = new Date();
      const expiresAt = ssoSessionExpiry(now, cfg.sessionMaxAgeHours, assertion.notOnOrAfter);
      const user = await updateUser(tx, r.user.id, { lastLoginAt: now });
      await writeAudit(ctx, tx, org, { actor: userActor(user), action: 'auth.login', data: { method: protocol } });
      const minted = await mintSession(tx, req, user, org, { loginMethod: protocol, expiresAt });
      return { ok: true as const, raw: minted.raw, maxAgeSec: Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)) };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent first login created the same user or identity; the next attempt resolves through rule 1.
    out = { ok: false, cause: 'email_conflict' };
  }
  if (!out.ok) {
    ctx.metrics.ssoLogins.inc({ protocol, result: out.cause });
    await chainFailure(ctx, org, protocol, out.cause, assertion.email);
    return reply.redirect(loginErrorUrl(ctx.config, out.cause), 303);
  }
  ctx.metrics.ssoLogins.inc({ protocol, result: 'ok' });
  setSessionCookie(ctx, reply, out.raw, out.maxAgeSec);
  return reply.redirect(`${ctx.config.webOrigin}${flow.returnTo}`, 303);
}
