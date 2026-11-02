/**
 * Phase E sections 3.3, 3.4 O4, 3.5: the per-org SP URLs. The org id makes the SAML audience and the OIDC redirect
 * URI unique per org; both are built from API_ORIGIN, never from a request header.
 */
import type { Config } from '../config.js';

type Origins = Pick<Config, 'apiOrigin' | 'webOrigin'>;

export const SSO_PREFIX = '/api/v1/auth/sso';

/** SAML SP entity id = the metadata URL (section 3.5). */
export function spEntityId(cfg: Origins, orgId: string): string {
  return `${cfg.apiOrigin}${SSO_PREFIX}/saml/${orgId}/metadata`;
}

export function spMetadataUrl(cfg: Origins, orgId: string): string {
  return spEntityId(cfg, orgId);
}

/** The ACS (HTTP-POST binding only). */
export function spAcsUrl(cfg: Origins, orgId: string): string {
  return `${cfg.apiOrigin}${SSO_PREFIX}/saml/${orgId}/acs`;
}

/** Section 3.4 O4: the per-org OIDC redirect URI registered at the org's IdP. */
export function oidcRedirectUri(cfg: Origins, orgId: string): string {
  return `${cfg.apiOrigin}${SSO_PREFIX}/oidc/${orgId}/callback`;
}

/** Section 3.3: `/api/v1/auth/sso/<orgSlug>/begin?login_hint=<email>` (relative to the api origin). */
export function beginPath(slug: string, opts: { loginHint?: string | null; returnTo?: string | null; test?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (opts.loginHint) q.set('login_hint', opts.loginHint);
  if (opts.returnTo) q.set('return_to', opts.returnTo);
  if (opts.test) q.set('test', opts.test);
  const qs = q.toString();
  return `${SSO_PREFIX}/${encodeURIComponent(slug)}/begin${qs ? `?${qs}` : ''}`;
}

/** `${WEB_ORIGIN}/login?sso_error=<code>`. */
export function loginErrorUrl(cfg: Origins, code: string): string {
  return `${cfg.webOrigin}/login?sso_error=${encodeURIComponent(code)}`;
}

/** Section 3.9 `POST /sso/test`: where a completed test flow lands. */
export function testResultUrl(cfg: Origins, result: string): string {
  return `${cfg.webOrigin}/app/settings/sso?test=${encodeURIComponent(result)}`;
}
