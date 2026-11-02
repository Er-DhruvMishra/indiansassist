/**
 * Phase E stream sso (docs/specs/phase-e-contracts.md section 3.9): the public sign-in routes (discover, info, begin,
 * the per-org OIDC callback, the SAML metadata and ACS) and the org_admin settings routes (config, SP key, test,
 * SSO required, break-glass, domains). Registered through `ENTERPRISE_ROUTE_PLUGINS` in app.ts.
 */
import { randomBytes } from 'node:crypto';
import {
  isPublicEmailDomain,
  isRegionServed,
  LIMITS,
  normaliseDomain,
  parseSsoConfig,
  safeReturnTo,
  SESSION_COOKIE_NAME,
  sha256Hex,
  ssoBreakGlassPutSchema,
  ssoDiscoverRequestSchema,
  ssoDomainCreateSchema,
  ssoPutRequestSchema,
  ssoRequiredPatchSchema,
  tierWithin,
  WS_CLOSE,
  emailDomainOf,
  type SsoConfig,
  type SsoDiscovery,
  type SsoErrorCode,
  type SsoFlowRecord,
  type SsoProtocol,
} from '@indiansassist/shared';
import { findVerifiedDomain, getOrg, getOrgBySlug, isUniqueViolation, type OrgRow } from '@indiansassist/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import { checkEgressUrl } from '../lib/egress.js';
import { orgSecretFingerprint, sealOrgSecret } from '../lib/org-secrets.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, principalFromCookieValue, unsignSessionCookie } from '../plugins/auth.js';
import { limits } from '../plugins/security.js';
import { finishSsoFlow } from './complete.js';
import { checkDomainTxt, toSsoDomain } from './domains.js';
import { bindingCookieName, clearBindingCookie, consumeFlow, setBindingCookie, TEST_TICKET_PREFIX } from './flow.js';
import { discoverOidc, forgetDiscovery, OidcSsoProvider } from './oidc.js';
import { SsoBeginError, type SsoProvider } from './provider.js';
import {
  capBreakGlassSessions,
  countDomainsByOrg,
  deleteDomain,
  getDomain,
  getOrgUsers,
  insertDomain,
  lockOrg,
  revokePasswordSessionsForSso,
  setBreakGlassUsers,
  updateDomain,
  updateOrgSso,
} from './repo.js';
import { SamlSsoProvider, spMetadataXml } from './saml.js';
import { checkIdpCertificate, generateSpKey } from './sp-key.js';
import { configDiffFields, freshSettings, settingsOf, ssoReadiness, usersOutsideVerifiedDomains } from './settings.js';
import { beginPath, loginErrorUrl, spEntityId, testResultUrl } from './urls.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const ADMIN_ROLES = ['org_admin'] as const;
const READ_ROLES = ['org_admin', 'auditor'] as const;

export function providerFor(ctx: AppContext, protocol: SsoProtocol): SsoProvider {
  return protocol === 'oidc' ? new OidcSsoProvider(ctx) : new SamlSsoProvider(ctx);
}

/** Section 2.5: SSO admin writes and domain verify, 20 / minute per org. */
async function orgWriteLimit(ctx: AppContext, orgId: string): Promise<void> {
  const r = await ctx.limiter.hit(`sso-admin:${orgId}`, 20, 60_000);
  if (!r.allowed) fail('rate_limited', 'too many SSO changes, try again shortly', { retryAfterSec: r.retryAfterSec });
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Section 3.4 O1 (forced-login CSRF): a begin proceeds only for `Sec-Fetch-Site: same-origin | none`, or `same-site`
 * with a Referer whose origin is exactly WEB_ORIGIN.
 */
export function crossSiteGuardPasses(req: FastifyRequest, webOrigin: string): boolean {
  const site = header(req, 'sec-fetch-site');
  if (site === 'same-origin' || site === 'none') return true;
  if (site === 'same-site') {
    const ref = header(req, 'referer');
    if (!ref) return false;
    try {
      return new URL(ref).origin === webOrigin;
    } catch {
      return false;
    }
  }
  return false;
}

async function chainBeginFailure(ctx: AppContext, org: OrgRow, protocol: SsoProtocol, cause: SsoErrorCode): Promise<void> {
  ctx.metrics.ssoLogins.inc({ protocol, result: cause });
  await writeAudit(ctx, ctx.db, org, { actor: systemActor, action: 'auth.sso_failed', data: { protocol, cause, emailHash: null } }).catch(
    (err: unknown) => ctx.log.error({ err }, 'auth.sso_failed could not be chained'),
  );
}

const beginQuerySchema = z.object({
  login_hint: z.string().optional(),
  return_to: z.string().optional(),
  test: z.string().optional(),
});

type TestTicket = { orgId: string; actingUserId: string };

export async function ssoRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // ---------- public: discovery, interstitial info, begin ----------

  app.post('/api/v1/auth/sso/discover', { config: limits.ssoDiscover }, async (req): Promise<SsoDiscovery> => {
    const body = parseOr400(ssoDiscoverRequestSchema, req.body);
    const domain = emailDomainOf(body.email);
    if (!domain) return { mode: 'password' };
    const claim = await findVerifiedDomain(ctx.db, domain);
    if (!claim) return { mode: 'password' };
    const org = await getOrg(ctx.db, claim.orgId);
    if (!org || !isRegionServed(org.dataRegion, ctx.config.servedRegions)) return { mode: 'password' };
    const cfg = parseSsoConfig(org.ssoConfig);
    if (!cfg || !cfg.enabled) return { mode: 'password' };
    return {
      mode: org.ssoRequired ? 'sso_required' : 'sso_available',
      displayName: cfg.displayName,
      beginUrl: beginPath(org.slug, { loginHint: body.email.trim() }),
    };
  });

  app.get<{ Params: { orgSlug: string } }>('/api/v1/auth/sso/:orgSlug/info', { config: limits.ssoDiscover }, async (req) => {
    const slug = req.params.orgSlug;
    const org = SLUG_RE.test(slug) ? await getOrgBySlug(ctx.db, slug) : null;
    const cfg = org ? parseSsoConfig(org.ssoConfig) : null;
    if (!org || !cfg || !cfg.enabled || !isRegionServed(org.dataRegion, ctx.config.servedRegions)) fail('not_found', 'not found');
    return { orgName: org.name, displayName: cfg.displayName, protocol: cfg.protocol };
  });

  app.get<{ Params: { orgSlug: string } }>('/api/v1/auth/sso/:orgSlug/begin', { config: limits.ssoBegin }, async (req, reply) => {
    const slug = req.params.orgSlug;
    const q = beginQuerySchema.safeParse(req.query ?? {});
    const query = q.success ? q.data : {};
    const loginHint = query.login_hint && query.login_hint.length <= 254 ? query.login_hint : null;
    const returnTo = safeReturnTo(query.return_to);
    const testTicket = query.test && /^[A-Za-z0-9_-]{20,64}$/.test(query.test) ? query.test : null;
    if (!crossSiteGuardPasses(req, ctx.config.webOrigin)) {
      const p = new URLSearchParams({ org: slug });
      if (loginHint) p.set('login_hint', loginHint);
      if (returnTo !== '/app') p.set('return_to', returnTo);
      if (testTicket) p.set('test', testTicket);
      return reply.redirect(`${ctx.config.webOrigin}/sso/continue?${p.toString()}`, 303);
    }
    const org = SLUG_RE.test(slug) ? await getOrgBySlug(ctx.db, slug) : null;
    const cfg = org ? parseSsoConfig(org.ssoConfig) : null;
    if (!org || !cfg || !isRegionServed(org.dataRegion, ctx.config.servedRegions)) return reply.redirect(loginErrorUrl(ctx.config, 'sso_disabled'), 303);

    let test: TestTicket | null = null;
    if (testTicket) {
      const raw = await ctx.presence.consume(`${TEST_TICKET_PREFIX}${sha256Hex(testTicket)}`);
      let t: TestTicket | null;
      try {
        t = raw ? (JSON.parse(raw) as TestTicket) : null;
      } catch {
        t = null;
      }
      // The test flow belongs to the admin who asked for it, in their own browser.
      const principal = await principalFromCookieValue(ctx, unsignSessionCookie(req.server, req.cookies[SESSION_COOKIE_NAME]));
      if (!t || t.orgId !== org.id || !principal || principal.user.id !== t.actingUserId)
        return reply.redirect(testResultUrl(ctx.config, 'flow_expired'), 303);
      test = t;
    } else if (!cfg.enabled) return reply.redirect(loginErrorUrl(ctx.config, 'sso_disabled'), 303);

    try {
      const out = await providerFor(ctx, cfg.protocol).begin(org, cfg, {
        loginHint,
        returnTo,
        test: test !== null,
        actingUserId: test?.actingUserId ?? null,
      });
      setBindingCookie(ctx.config, reply, out.bindingCookie);
      return reply.redirect(out.redirectUrl, 302);
    } catch (err) {
      const code: SsoErrorCode = err instanceof SsoBeginError ? err.code : 'idp_error';
      if (!(err instanceof SsoBeginError)) req.log.warn({ err }, 'sso begin failed');
      await chainBeginFailure(ctx, org, cfg.protocol, code);
      return reply.redirect(test ? testResultUrl(ctx.config, code) : loginErrorUrl(ctx.config, code), 303);
    }
  });

  // ---------- public: the OIDC callback (section 3.4 O5-O8) ----------

  app.get<{ Params: { orgId: string } }>('/api/v1/auth/sso/oidc/:orgId/callback', { config: limits.ssoReturn }, async (req, reply) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const query = new URLSearchParams(qs);
    const state = query.get('state') ?? '';
    const routeOrgId = UUID_RE.test(req.params.orgId) ? req.params.orgId.toLowerCase() : '';
    const flow = state ? await consumeFlow(ctx.presence, state) : null;
    if (!flow || !routeOrgId) {
      ctx.metrics.ssoLogins.inc({ protocol: 'oidc', result: 'flow_expired' });
      return reply.redirect(loginErrorUrl(ctx.config, 'flow_expired'), 303);
    }
    const cookieName = bindingCookieName(state);
    const cookie = req.cookies[cookieName];
    clearBindingCookie(ctx.config, reply, cookieName, 'lax');
    const result = await new OidcSsoProvider(ctx).complete(flow, { routeOrgId, query, bindingCookie: cookie });
    return finishSsoFlow(ctx, req, reply, flow, result);
  });

  // ---------- public: SAML metadata and ACS (section 3.5) ----------

  app.get<{ Params: { orgId: string } }>('/api/v1/auth/sso/saml/:orgId/metadata', async (req, reply) => {
    const org = UUID_RE.test(req.params.orgId) ? await getOrg(ctx.db, req.params.orgId) : null;
    const cfg = org ? parseSsoConfig(org.ssoConfig) : null;
    if (!org || !cfg || cfg.protocol !== 'saml' || !cfg.saml || !isRegionServed(org.dataRegion, ctx.config.servedRegions))
      fail('not_found', 'not found');
    return reply
      .header('Content-Type', 'application/samlmetadata+xml')
      .header('Cache-Control', 'public, max-age=300')
      .send(spMetadataXml(ctx, org, cfg));
  });

  // The ACS has its own form parser (body <= LIMITS.samlResponseMaxBytes), registered only in this encapsulated plugin.
  await app.register(async (acs) => {
    acs.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: LIMITS.samlResponseMaxBytes },
      (_req, body, done) => done(null, body),
    );
    acs.post<{ Params: { orgId: string } }>(
      '/api/v1/auth/sso/saml/:orgId/acs',
      { config: limits.ssoReturn, bodyLimit: LIMITS.samlResponseMaxBytes },
      async (req, reply) => {
        const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
        const relay = form.getAll('RelayState');
        const responses = form.getAll('SAMLResponse');
        if (responses.length !== 1) {
          ctx.metrics.ssoLogins.inc({ protocol: 'saml', result: 'invalid_response' });
          return reply.redirect(loginErrorUrl(ctx.config, 'invalid_response'), 303);
        }
        // (1) W63: a Response without RelayState is IdP-initiated, which is refused.
        if (relay.length !== 1 || !relay[0]) {
          ctx.metrics.ssoLogins.inc({ protocol: 'saml', result: 'unsolicited' });
          return reply.redirect(loginErrorUrl(ctx.config, 'unsolicited'), 303);
        }
        const relayState = relay[0];
        const routeOrgId = UUID_RE.test(req.params.orgId) ? req.params.orgId.toLowerCase() : '';
        const flow: SsoFlowRecord | null = await consumeFlow(ctx.presence, relayState);
        if (!flow || !routeOrgId) {
          ctx.metrics.ssoLogins.inc({ protocol: 'saml', result: 'flow_expired' });
          return reply.redirect(loginErrorUrl(ctx.config, 'flow_expired'), 303);
        }
        const cookieName = bindingCookieName(relayState);
        const cookie = req.cookies[cookieName];
        clearBindingCookie(ctx.config, reply, cookieName, 'none');
        const result = await new SamlSsoProvider(ctx).complete(flow, {
          routeOrgId,
          form: { SAMLResponse: responses[0]!, RelayState: relayState },
          bindingCookie: cookie,
        });
        return finishSsoFlow(ctx, req, reply, flow, result);
      },
    );
  });

  // ---------- org_admin: settings ----------

  app.get('/api/v1/orgs/current/sso', async (req) => {
    const p = await authenticate(ctx, req, READ_ROLES);
    return settingsOf(ctx, ctx.db, p.org);
  });

  app.put('/api/v1/orgs/current/sso', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const body = parseOr400(ssoPutRequestSchema, req.body);
    const cfg: SsoConfig = body.config;
    const org = p.org;
    const before = parseSsoConfig(org.ssoConfig);
    if (org.ssoRequired && !cfg.enabled) fail('sso_required_on', 'SSO is required for this organisation; turn that off first');
    if (!tierWithin(cfg.jit.defaultSeatTier, org.planTier)) fail('tier_not_licensed', `the org plan does not include ${cfg.jit.defaultSeatTier}`);
    const egressDeps = { config: ctx.config.egress, lookup: (h: string) => ctx.dnsResolver.lookup(h) };
    if (cfg.protocol === 'oidc' && cfg.oidc) {
      const oc = cfg.oidc;
      const hasSecret = body.clientSecret === undefined ? org.ssoSecretEnc !== null : body.clientSecret !== null;
      if (cfg.enabled && oc.tokenEndpointAuth !== 'none' && !hasSecret)
        fail('validation_failed', `a client secret is needed for ${oc.tokenEndpointAuth}`, { issues: [{ path: ['clientSecret'], message: 'required' }] });
      const egress = await checkEgressUrl(oc.issuer, egressDeps);
      if (!egress.ok) fail('egress_refused', 'the issuer URL is not allowed', { cause: egress.cause });
      const d = await discoverOidc(ctx, org.id, oc, { fresh: true });
      if (!d.ok) {
        if (d.egress === 'refused') fail('egress_refused', 'the issuer URL is not allowed', { cause: d.cause });
        fail('sso_discovery_failed', 'the OpenID discovery document could not be fetched or validated', { cause: d.cause });
      }
    }
    if (cfg.protocol === 'saml' && cfg.saml) {
      const sc = cfg.saml;
      for (const pem of sc.idpCertificates) {
        const c = checkIdpCertificate(pem);
        if (!c.ok) fail('sso_cert_invalid', 'an IdP certificate is not an unexpired RSA certificate of at least 2048 bits', { reason: c.reason });
      }
      if (!/^https:/i.test(sc.ssoUrl) && !(ctx.config.egress.allowHttp && /^http:/i.test(sc.ssoUrl)))
        fail('validation_failed', 'the IdP sign-on URL must be https', { issues: [{ path: ['config', 'saml', 'ssoUrl'], message: 'https only' }] });
      if (sc.signAuthnRequests && !org.ssoSpKeyEnc)
        fail('validation_failed', 'generate an SP key before signing AuthnRequests', {
          issues: [{ path: ['config', 'saml', 'signAuthnRequests'], message: 'no SP key' }],
        });
    }
    const secretChanged = body.clientSecret !== undefined;
    const secretPatch =
      body.clientSecret === undefined
        ? {}
        : body.clientSecret === null
          ? { ssoSecretEnc: null, ssoSecretSetAt: null, ssoSecretFp: null }
          : {
              ssoSecretEnc: sealOrgSecret(ctx, { orgId: org.id, purpose: 'sso-oidc-client-secret', recordId: org.id }, body.clientSecret),
              ssoSecretSetAt: new Date(),
              ssoSecretFp: orgSecretFingerprint(ctx, body.clientSecret),
            };
    const updated = await ctx.db.transaction(async (tx) => {
      const locked = await lockOrg(tx, org.id);
      if (locked?.ssoRequired && !cfg.enabled) fail('sso_required_on', 'SSO is required for this organisation; turn that off first');
      const row = await updateOrgSso(tx, org.id, { ssoConfig: cfg as unknown as Record<string, unknown>, ...secretPatch });
      await writeAudit(ctx, tx, org, {
        actor: userActor(p.user),
        action: 'sso.config_updated',
        data: { protocol: cfg.protocol, enabled: cfg.enabled, fields: configDiffFields(before, cfg), secretChanged },
      });
      return row;
    });
    forgetDiscovery(ctx, org.id);
    if (cfg.protocol === 'oidc' && cfg.oidc) await discoverOidc(ctx, org.id, cfg.oidc, { fresh: true });
    return settingsOf(ctx, ctx.db, updated);
  });

  app.post('/api/v1/orgs/current/sso/sp-key', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const key = await generateSpKey(spEntityId(ctx.config, p.org.id));
    await ctx.db.transaction(async (tx) => {
      await updateOrgSso(tx, p.org.id, {
        ssoSpKeyEnc: sealOrgSecret(ctx, { orgId: p.org.id, purpose: 'sso-saml-sp-key', recordId: p.org.id }, key.privateKeyPem),
        ssoSpKeySetAt: new Date(),
        ssoSpKeyFp: orgSecretFingerprint(ctx, key.privateKeyPem),
        ssoSpCert: key.certPem,
      });
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'sso.sp_key_rotated', data: { certSha256: key.certSha256 } });
    });
    return { certPem: key.certPem };
  });

  app.post('/api/v1/orgs/current/sso/test', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    if (!parseSsoConfig(p.org.ssoConfig)) fail('bad_state', 'configure SSO before testing it');
    const ticket = randomBytes(24).toString('base64url');
    const t: TestTicket = { orgId: p.org.id, actingUserId: p.user.id };
    await ctx.presence.setKey(`${TEST_TICKET_PREFIX}${sha256Hex(ticket)}`, JSON.stringify(t), LIMITS.ssoFlowTtlSec);
    return { beginUrl: beginPath(p.org.slug, { test: ticket }) };
  });

  app.patch('/api/v1/orgs/current/sso/required', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const body = parseOr400(ssoRequiredPatchSchema, req.body);
    if (body.required) {
      const missing = await ssoReadiness(ctx.db, p.org, p.user.id);
      if (missing.length > 0) fail('sso_not_ready', 'SSO cannot be required yet', { missing });
    }
    const warnings = { usersOutsideVerifiedDomains: await usersOutsideVerifiedDomains(ctx.db, p.org.id) };
    if (body.dryRun || body.required === p.org.ssoRequired) return { ...(await settingsOf(ctx, ctx.db, p.org)), warnings };
    let revokedIds: string[] = [];
    await ctx.db.transaction(async (tx) => {
      const locked = await lockOrg(tx, p.org.id);
      if (!locked) fail('not_found', 'org not found');
      if (body.required) {
        const missing = await ssoReadiness(tx, locked, p.user.id);
        if (missing.length > 0) fail('sso_not_ready', 'SSO cannot be required yet', { missing });
        await updateOrgSso(tx, p.org.id, { ssoRequired: true });
        revokedIds = await revokePasswordSessionsForSso(tx, p.org.id);
        await capBreakGlassSessions(tx, p.org.id, LIMITS.breakGlassSessionHours);
      } else await updateOrgSso(tx, p.org.id, { ssoRequired: false });
      await writeAudit(ctx, tx, p.org, {
        actor: userActor(p.user),
        action: 'sso.required_changed',
        data: { required: body.required, revokedSessions: revokedIds.length },
      });
    });
    if (revokedIds.length > 0) ctx.hub.closeSocketsForAuthSessions(revokedIds, WS_CLOSE.unauthenticated);
    return { ...(await freshSettings(ctx, p.org.id)), warnings };
  });

  app.put('/api/v1/orgs/current/sso/break-glass', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const loose = z.object({ userIds: z.array(z.string()) }).safeParse(req.body ?? {});
    if (loose.success && new Set(loose.data.userIds).size > LIMITS.ssoBreakGlassMax)
      fail('break_glass_invalid_user', `at most ${LIMITS.ssoBreakGlassMax} break-glass administrators`);
    const ids = [...new Set(parseOr400(ssoBreakGlassPutSchema, req.body).userIds.map((s) => s.toLowerCase()))];
    await ctx.db.transaction(async (tx) => {
      const locked = await lockOrg(tx, p.org.id);
      if (!locked) fail('not_found', 'org not found');
      const users = await getOrgUsers(tx, p.org.id, ids);
      if (users.length !== ids.length || users.some((u) => u.status !== 'active' || u.role !== 'org_admin' || !u.passwordHash))
        fail('break_glass_invalid_user', 'break-glass users must be active org admins with a password');
      if (locked.ssoRequired && ids.length === 0) fail('last_break_glass', 'SSO is required; keep at least one break-glass administrator');
      await setBreakGlassUsers(tx, p.org.id, ids);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'sso.break_glass_changed', data: { userIds: ids } });
    });
    return freshSettings(ctx, p.org.id);
  });

  // ---------- org_admin: domains (section 3.2) ----------

  app.get('/api/v1/orgs/current/sso/domains', async (req) => {
    const p = await authenticate(ctx, req, READ_ROLES);
    return { items: (await settingsOf(ctx, ctx.db, p.org)).domains };
  });

  app.post('/api/v1/orgs/current/sso/domains', async (req, reply) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const body = parseOr400(ssoDomainCreateSchema, req.body);
    const domain = normaliseDomain(body.domain);
    if (!domain) fail('domain_invalid', 'not a valid domain name');
    if (isPublicEmailDomain(domain)) fail('domain_not_allowed', 'a public mail domain cannot be claimed');
    if ((await countDomainsByOrg(ctx.db, p.org.id)) >= LIMITS.ssoDomainsMax) fail('domain_limit', `at most ${LIMITS.ssoDomainsMax} domains`);
    try {
      const row = await ctx.db.transaction(async (tx) => {
        const r = await insertDomain(tx, { orgId: p.org.id, domain, verifyToken: randomBytes(16).toString('hex'), createdBy: p.user.id });
        await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'sso.domain_added', data: { domainId: r.id, domain } });
        return r;
      });
      return reply.status(201).send(toSsoDomain(row));
    } catch (err) {
      if (isUniqueViolation(err)) fail('domain_exists', 'this domain is already listed');
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/orgs/current/sso/domains/:id/verify', async (req) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const row = UUID_RE.test(req.params.id) ? await getDomain(ctx.db, p.org.id, req.params.id) : null;
    if (!row) fail('not_found', 'domain not found');
    const r = await checkDomainTxt(ctx, row.domain, row.verifyToken);
    const now = new Date();
    if (!r.matched) {
      await updateDomain(ctx.db, row.id, { lastCheckedAt: now });
      fail('domain_unverified', 'the TXT record was not found', { found: r.found });
    }
    if (row.status === 'verified') return toSsoDomain(await updateDomain(ctx.db, row.id, { lastCheckedAt: now, misses: 0 }));
    const other = await findVerifiedDomain(ctx.db, row.domain);
    if (other && other.orgId !== p.org.id) fail('domain_taken', 'another organisation in this region has verified this domain');
    try {
      const updated = await ctx.db.transaction(async (tx) => {
        const u = await updateDomain(tx, row.id, { status: 'verified', verifiedAt: now, lastCheckedAt: now, misses: 0 });
        await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'sso.domain_verified', data: { domainId: row.id, domain: row.domain } });
        return u;
      });
      return toSsoDomain(updated);
    } catch (err) {
      if (isUniqueViolation(err)) fail('domain_taken', 'another organisation in this region has verified this domain');
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/orgs/current/sso/domains/:id', async (req, reply) => {
    const p = await authenticate(ctx, req, ADMIN_ROLES);
    await orgWriteLimit(ctx, p.org.id);
    const row = UUID_RE.test(req.params.id) ? await getDomain(ctx.db, p.org.id, req.params.id) : null;
    if (!row) fail('not_found', 'domain not found');
    await ctx.db.transaction(async (tx) => {
      const locked = await lockOrg(tx, p.org.id);
      if (locked?.ssoRequired && row.status === 'verified') {
        const verified = (await settingsOf(ctx, tx, locked)).domains.filter((d) => d.status === 'verified');
        if (verified.length <= 1) fail('sso_required_on', 'SSO is required; this is the last verified domain');
      }
      await deleteDomain(tx, row.id);
      await writeAudit(ctx, tx, p.org, { actor: userActor(p.user), action: 'sso.domain_removed', data: { domainId: row.id, domain: row.domain } });
    });
    return reply.status(204).send();
  });
}
