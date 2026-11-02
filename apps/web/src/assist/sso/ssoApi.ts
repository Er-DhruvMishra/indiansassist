/**
 * Phase E section 3.9 in the console (stream sso): the SSO REST calls, the begin-link builder and the plain words
 * for every `?sso_error=` / test result code (section 13.4).
 */
import {
  ssoDiscoverySchema,
  ssoDomainSchema,
  ssoDomainsPageSchema,
  ssoInfoSchema,
  ssoRequiredReplySchema,
  ssoSettingsSchema,
  ssoSpKeyReplySchema,
  ssoTestReplySchema,
  type SsoConfig,
  type SsoDiscovery,
  type SsoDomain,
  type SsoErrorCode,
  type SsoInfo,
  type SsoSettings,
} from '@indiansassist/shared';
import { API_URL } from '../../config';
import { api, request } from '../../lib/api';

export type SsoRequiredReply = SsoSettings & { warnings: { usersOutsideVerifiedDomains: number } };

export const ssoApi = {
  discover: (email: string) => api.post<SsoDiscovery>('/auth/sso/discover', { email }, { schema: ssoDiscoverySchema }),
  info: (slug: string) => api.get<SsoInfo>(`/auth/sso/${encodeURIComponent(slug)}/info`, { schema: ssoInfoSchema }),
  settings: () => api.get<SsoSettings>('/orgs/current/sso', { schema: ssoSettingsSchema }),
  save: (config: SsoConfig, clientSecret?: string | null) =>
    request<SsoSettings>('PUT', '/orgs/current/sso', {
      body: clientSecret === undefined ? { config } : { config, clientSecret },
      schema: ssoSettingsSchema,
    }),
  rotateSpKey: () => api.post<{ certPem: string }>('/orgs/current/sso/sp-key', undefined, { schema: ssoSpKeyReplySchema }),
  test: () => api.post<{ beginUrl: string }>('/orgs/current/sso/test', undefined, { schema: ssoTestReplySchema }),
  setRequired: (required: boolean, dryRun = false) =>
    api.patch<SsoRequiredReply>('/orgs/current/sso/required', dryRun ? { required, dryRun } : { required }, { schema: ssoRequiredReplySchema }),
  setBreakGlass: (userIds: string[]) => request<SsoSettings>('PUT', '/orgs/current/sso/break-glass', { body: { userIds }, schema: ssoSettingsSchema }),
  domains: () => api.get<{ items: SsoDomain[] }>('/orgs/current/sso/domains', { schema: ssoDomainsPageSchema }),
  addDomain: (domain: string) => api.post<SsoDomain>('/orgs/current/sso/domains', { domain }, { schema: ssoDomainSchema }),
  verifyDomain: (id: string) => api.post<SsoDomain>(`/orgs/current/sso/domains/${id}/verify`, undefined, { schema: ssoDomainSchema }),
  removeDomain: (id: string) => request<void>('DELETE', `/orgs/current/sso/domains/${id}`),
};

/**
 * The absolute URL of a begin path the api returned (`/api/v1/auth/sso/<slug>/begin?...`). Only that path shape is
 * accepted, so a value from anywhere else can never send the browser to another site.
 */
export function beginHref(beginUrl: string): string | null {
  if (!/^\/api\/v1\/auth\/sso\/[a-z0-9-]{3,40}\/begin(\?[^#\s]*)?$/.test(beginUrl)) return null;
  return `${API_URL}${beginUrl}`;
}

/** The begin URL of an org, built in the browser (the /sso/continue interstitial). */
export function beginPathFor(slug: string, params: { loginHint?: string | null; returnTo?: string | null; test?: string | null }): string {
  const q = new URLSearchParams();
  if (params.loginHint) q.set('login_hint', params.loginHint);
  if (params.returnTo) q.set('return_to', params.returnTo);
  if (params.test) q.set('test', params.test);
  const qs = q.toString();
  return `/api/v1/auth/sso/${encodeURIComponent(slug)}/begin${qs ? `?${qs}` : ''}`;
}

/** Section 13.4: each code in plain words. */
export const SSO_ERROR_TEXT: Record<SsoErrorCode, string> = {
  sso_disabled: 'Single sign-on is not turned on for this organisation on this server.',
  flow_expired: 'The sign-in took too long or was already used. Start again.',
  binding_mismatch: 'The sign-in was started in another browser or for another organisation. Start again from this browser.',
  idp_error: 'Your identity provider reported an error or could not be reached. Try again, or ask your administrator.',
  invalid_response: 'The answer from your identity provider did not pass our security checks.',
  email_missing: 'Your identity provider did not send an email address.',
  email_unverified: 'Your identity provider says your email address is not verified.',
  claim_mismatch: 'This account is not allowed to sign in to this organisation (for example a personal account).',
  domain_not_verified: "Your email domain is not verified for this organisation, so we cannot match or create your account.",
  user_disabled: 'Your account in this organisation is disabled. Ask an administrator.',
  jit_disabled: 'There is no account for you in this organisation and new accounts are not created automatically. Ask an administrator for an invite.',
  email_conflict: 'This email address already belongs to an account in another organisation.',
  seat_unavailable: "The organisation's plan has no seat of the configured type for a new account. Ask an administrator.",
  replay: 'This sign-in answer was already used.',
  unsolicited: 'Sign-in must start here, not at the identity provider. Start again from this page.',
};

export function ssoErrorText(code: string | null): string | null {
  if (!code) return null;
  return (SSO_ERROR_TEXT as Record<string, string>)[code] ?? 'Single sign-on failed. Try again.';
}
