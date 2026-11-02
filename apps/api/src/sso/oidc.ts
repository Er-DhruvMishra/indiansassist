/**
 * Phase E section 3.4: OIDC sign-in, authorization code + PKCE S256 on the per-org callback, with openid-client 6
 * given `egressFetch` as its custom fetch (section 2.2). The api checks the RFC 9207 `iss` parameter, the ID token's
 * signature algorithm and `azp` itself, whether or not the library also does.
 */
import { randomBytes } from 'node:crypto';
import * as client from 'openid-client';
import {
  parseSsoConfig,
  sha256Hex,
  type EgressPurpose,
  type SsoAssertion,
  type SsoConfig,
  type SsoErrorCode,
  type SsoFlowRecord,
  type SsoOidcConfig,
} from '@indiansassist/shared';
import { getOrg, type OrgRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { EgressFailedError, EgressRefusedError } from '../lib/egress.js';
import { openOrgSecretWithReseal } from '../lib/org-secrets.js';
import { bindingCookieName, bindingMatches, randomHandle, saveFlow } from './flow.js';
import {
  normaliseAssertedEmail,
  normaliseGroups,
  sanitiseName,
  SsoBeginError,
  type SsoBeginInput,
  type SsoBeginResult,
  type SsoCompleteInput,
  type SsoCompleteResult,
  type SsoProvider,
} from './provider.js';
import { oidcRedirectUri } from './urls.js';

/** O2: discovery documents are cached in memory for 1 h, keyed by (orgId, issuer, clientId). */
export const DISCOVERY_TTL_MS = 60 * 60_000;
/** O6: ID token signature algorithms accepted (`HS*` and `none` refused). */
export const ID_TOKEN_ALGS = new Set(['RS256', 'PS256', 'ES256', 'EdDSA', 'Ed25519']);
/** O6: `exp` / `iat` skew. */
export const ID_TOKEN_SKEW_SEC = 120;

type Metadata = client.ServerMetadata;
type CacheEntry = { at: number; metadata: Metadata };
const caches = new WeakMap<object, Map<string, CacheEntry>>();

function cacheOf(ctx: AppContext): Map<string, CacheEntry> {
  let m = caches.get(ctx);
  if (!m) {
    m = new Map();
    caches.set(ctx, m);
  }
  return m;
}

function cacheKey(orgId: string, oc: Pick<SsoOidcConfig, 'issuer' | 'clientId'>): string {
  return JSON.stringify([orgId, oc.issuer, oc.clientId]);
}

/** Two URLs equal after WHATWG normalisation (a bare origin gains its trailing slash). */
export function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** The first Egress error in an error's cause chain (openid-client may wrap what the fetch threw). */
export function egressErrorIn(err: unknown): EgressRefusedError | EgressFailedError | null {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof EgressRefusedError || e instanceof EgressFailedError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** openid-client's custom fetch over `ctx.egressFetch`, the purpose read from which endpoint is called. */
function egressCustomFetch(ctx: AppContext, orgId: string, md: () => Metadata | null): client.CustomFetch {
  return async (url, options) => {
    const m = md();
    let purpose: EgressPurpose = 'sso_discovery';
    if (m) {
      if (m.jwks_uri && sameUrl(url, m.jwks_uri)) purpose = 'sso_jwks';
      else if (m.token_endpoint && sameUrl(url, m.token_endpoint)) purpose = 'sso_token';
      else if (m.userinfo_endpoint && sameUrl(url, m.userinfo_endpoint)) purpose = 'sso_userinfo';
    }
    const headers: Record<string, string> = {};
    new Headers(options.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => {
      headers[k] = v;
    });
    const body = options.body instanceof URLSearchParams ? options.body.toString() : (options.body as RequestInit['body']);
    return ctx.egressFetch(url, { method: options.method, headers, ...(body !== undefined ? { body } : {}) }, { purpose, orgId });
  };
}

function isHttp(url: string): boolean {
  return /^http:/i.test(url);
}

export type DiscoveryOutcome = { ok: true; metadata: Metadata } | { ok: false; cause: string; egress: 'refused' | 'failed' | null };

/**
 * O2 / save-time discovery: fetches `${issuer}/.well-known/openid-configuration` through egressFetch, requires the
 * document's issuer to equal the configured one and the endpoints the flow needs. `fresh` skips (and refills) the cache.
 */
export async function discoverOidc(
  ctx: AppContext,
  orgId: string,
  oc: Pick<SsoOidcConfig, 'issuer' | 'clientId'>,
  opts: { fresh?: boolean } = {},
): Promise<DiscoveryOutcome> {
  const cache = cacheOf(ctx);
  const key = cacheKey(orgId, oc);
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return { ok: true, metadata: hit.metadata };
  let metadata: Metadata;
  try {
    const conf = await client.discovery(new URL(oc.issuer), oc.clientId, undefined, client.None(), {
      [client.customFetch]: egressCustomFetch(ctx, orgId, () => null),
      execute: isHttp(oc.issuer) && ctx.config.egress.allowHttp ? [client.allowInsecureRequests] : [],
    });
    metadata = conf.serverMetadata();
  } catch (err) {
    const eg = egressErrorIn(err);
    if (eg instanceof EgressRefusedError) return { ok: false, cause: eg.cause, egress: 'refused' };
    if (eg instanceof EgressFailedError) return { ok: false, cause: eg.kind === 'timeout' ? 'timeout' : 'unreachable', egress: 'failed' };
    const msg = err instanceof Error ? err.message : '';
    if (/issuer/i.test(msg)) return { ok: false, cause: 'issuer_mismatch', egress: null };
    if (/status code/i.test(msg)) return { ok: false, cause: 'http_status', egress: null };
    return { ok: false, cause: 'invalid_document', egress: null };
  }
  if (!sameUrl(metadata.issuer, oc.issuer)) return { ok: false, cause: 'issuer_mismatch', egress: null };
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri)
    return { ok: false, cause: 'missing_endpoint', egress: null };
  cache.set(key, { at: Date.now(), metadata });
  return { ok: true, metadata };
}

/** Drops every cached discovery document of an org (a saved config always re-discovers). */
export function forgetDiscovery(ctx: AppContext, orgId: string): void {
  const cache = cacheOf(ctx);
  for (const k of [...cache.keys()]) if ((JSON.parse(k) as string[])[0] === orgId) cache.delete(k);
}

function configuration(ctx: AppContext, orgId: string, oc: SsoOidcConfig, md: Metadata, auth: client.ClientAuth): client.Configuration {
  const conf = new client.Configuration(md, oc.clientId, { [client.clockTolerance]: ID_TOKEN_SKEW_SEC } as Partial<client.ClientMetadata>, auth);
  conf[client.customFetch] = egressCustomFetch(ctx, orgId, () => md);
  if (isHttp(md.issuer) && ctx.config.egress.allowHttp) client.allowInsecureRequests(conf);
  // O6: the ID token signature is verified against the discovered JWKS (openid-client skips it by default).
  client.enableNonRepudiationChecks(conf);
  return conf;
}

function b64urlJson(segment: string | undefined): Record<string, unknown> | null {
  if (!segment) return null;
  try {
    const v = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** O7: a string claim equal to one of `values`, or an array claim containing one. */
export function claimSatisfied(claim: unknown, values: readonly string[]): boolean {
  if (typeof claim === 'string') return values.includes(claim);
  if (Array.isArray(claim)) return claim.some((c) => typeof c === 'string' && values.includes(c));
  return false;
}

export class OidcSsoProvider implements SsoProvider {
  readonly protocol = 'oidc' as const;
  constructor(private readonly ctx: AppContext) {}

  async begin(org: OrgRow, cfg: SsoConfig, input: SsoBeginInput): Promise<SsoBeginResult> {
    const oc = cfg.oidc;
    if (!oc) throw new SsoBeginError('sso_disabled');
    const d = await discoverOidc(this.ctx, org.id, oc);
    if (!d.ok) throw new SsoBeginError('idp_error', `discovery failed: ${d.cause}`);
    const conf = configuration(this.ctx, org.id, oc, d.metadata, client.None());
    const state = client.randomState();
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = client.randomPKCECodeVerifier();
    const b = randomHandle();
    await saveFlow(this.ctx.presence, state, {
      v: 1,
      orgId: org.id,
      protocol: 'oidc',
      bindingHash: sha256Hex(b),
      codeVerifier,
      nonce,
      returnTo: input.returnTo,
      test: input.test,
      actingUserId: input.test ? input.actingUserId : null,
      createdAt: new Date().toISOString(),
    });
    const params: Record<string, string> = {
      redirect_uri: oidcRedirectUri(this.ctx.config, org.id),
      scope: oc.scopes.join(' '),
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    };
    if (input.loginHint) params['login_hint'] = input.loginHint;
    const url = client.buildAuthorizationUrl(conf, params);
    return { redirectUrl: url.href, bindingCookie: { name: bindingCookieName(state), value: b, sameSite: 'lax' } };
  }

  async complete(flow: SsoFlowRecord, input: SsoCompleteInput): Promise<SsoCompleteResult> {
    const fail = (cause: SsoErrorCode, email: string | null = null): SsoCompleteResult => ({ ok: false, orgId: flow.orgId, cause, email });
    // O5: the flow is bound to the callback's org and protocol, then to this browser.
    if (flow.orgId !== input.routeOrgId || flow.protocol !== 'oidc') return fail('binding_mismatch');
    if (!bindingMatches(flow, input.bindingCookie)) return fail('binding_mismatch');
    const q = input.query ?? new URLSearchParams();
    if (q.has('error')) return fail('idp_error');
    // Only flow.orgId's configuration is loaded; nothing in the request selects another org.
    const org = await getOrg(this.ctx.db, flow.orgId);
    const cfg = org ? parseSsoConfig(org.ssoConfig) : null;
    if (!org || !cfg || cfg.protocol !== 'oidc' || !cfg.oidc || (!cfg.enabled && !flow.test)) return fail('sso_disabled');
    const oc = cfg.oidc;
    const d = await discoverOidc(this.ctx, org.id, oc);
    if (!d.ok) return fail('idp_error');
    const md = d.metadata;
    // RFC 9207 mix-up defence, checked here whatever the library does.
    const iss = q.get('iss');
    if (iss !== null && !sameUrl(iss, md.issuer)) return fail('invalid_response');
    if (iss === null && md.authorization_response_iss_parameter_supported === true) return fail('invalid_response');
    if (!q.get('code')) return fail('invalid_response');

    let auth: client.ClientAuth;
    if (oc.tokenEndpointAuth === 'none') auth = client.None();
    else {
      if (!org.ssoSecretEnc) return fail('idp_error');
      let secret: string;
      try {
        secret = await openOrgSecretWithReseal(
          this.ctx,
          this.ctx.db,
          { orgId: org.id, purpose: 'sso-oidc-client-secret', recordId: org.id },
          org.ssoSecretEnc,
          { column: 'org.sso_secret_enc', rowId: org.id },
        );
      } catch {
        return fail('idp_error');
      }
      auth = oc.tokenEndpointAuth === 'client_secret_basic' ? client.ClientSecretBasic(secret) : client.ClientSecretPost(secret);
    }
    const conf = configuration(this.ctx, org.id, oc, md, auth);
    const currentUrl = new URL(`${oidcRedirectUri(this.ctx.config, org.id)}?${q.toString()}`);
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(conf, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: q.get('state') ?? '',
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
    } catch (err) {
      if (egressErrorIn(err)) return fail('idp_error');
      if (err instanceof client.ResponseBodyError || err instanceof client.AuthorizationResponseError) return fail('idp_error');
      return fail('invalid_response');
    }
    const idToken = tokens.id_token;
    const header = b64urlJson(idToken?.split('.')[0]);
    const alg = typeof header?.['alg'] === 'string' ? header['alg'] : '';
    if (!idToken || !ID_TOKEN_ALGS.has(alg)) return fail('invalid_response');
    const claims = tokens.claims() as Record<string, unknown> | undefined;
    if (!claims) return fail('invalid_response');
    if (!sameUrl(String(claims['iss'] ?? ''), oc.issuer)) return fail('invalid_response');
    const aud = claims['aud'];
    const audList = Array.isArray(aud) ? aud : [aud];
    if (!audList.includes(oc.clientId)) return fail('invalid_response');
    if (audList.length > 1 && claims['azp'] !== oc.clientId) return fail('invalid_response');
    if (claims['azp'] !== undefined && claims['azp'] !== oc.clientId) return fail('invalid_response');
    const now = Math.floor(Date.now() / 1000);
    const exp = Number(claims['exp']);
    const iat = Number(claims['iat']);
    if (!Number.isFinite(exp) || exp + ID_TOKEN_SKEW_SEC < now) return fail('invalid_response');
    if (!Number.isFinite(iat) || iat - ID_TOKEN_SKEW_SEC > now) return fail('invalid_response');
    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) return fail('invalid_response');

    // O7: requiredClaims are satisfied by the ID token before anything else is resolved.
    for (const rc of oc.requiredClaims) if (!claimSatisfied(claims[rc.name], rc.values)) return fail('claim_mismatch');

    let source: Record<string, unknown> = claims;
    if (claims[oc.emailClaim] === undefined) {
      if (!md.userinfo_endpoint || !tokens.access_token) return fail('email_missing');
      try {
        source = (await client.fetchUserInfo(conf, tokens.access_token, sub)) as Record<string, unknown>;
      } catch (err) {
        if (egressErrorIn(err)) return fail('idp_error');
        return fail('invalid_response');
      }
      if (source['sub'] !== sub) return fail('invalid_response');
    }
    const email = normaliseAssertedEmail(source[oc.emailClaim]);
    if (!email) return fail('email_missing');
    const ev = source['email_verified'];
    const emailVerified = ev === true || ev === 'true' ? true : ev === false || ev === 'false' ? false : null;
    if (emailVerified === false) return fail('email_unverified', email);
    const groupsRaw = oc.groupsClaim ? (claims[oc.groupsClaim] ?? source[oc.groupsClaim]) : undefined;
    const assertion: SsoAssertion = {
      protocol: 'oidc',
      issuer: String(claims['iss']),
      subject: sub,
      email,
      emailVerified,
      name: sanitiseName(claims[oc.nameClaim] ?? source[oc.nameClaim]),
      groups: Array.isArray(groupsRaw) ? normaliseGroups(groupsRaw) : [],
      notOnOrAfter: null,
    };
    return { ok: true, org, assertion };
  }
}
