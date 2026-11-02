/**
 * Phase E section 3.10: the per-org, per-protocol SSO seam. `AuthProvider` (adapters/auth-provider.ts) stays the
 * password provider; `OidcSsoProvider` (oidc.ts) and `SamlSsoProvider` (saml.ts) implement this interface.
 */
import type { SsoAssertion, SsoConfig, SsoErrorCode, SsoFlowRecord, SsoProtocol } from '@indiansassist/shared';
import type { OrgRow } from '@indiansassist/db';

export type SsoBeginInput = { loginHint: string | null; returnTo: string; test: boolean; actingUserId: string | null };

export type SsoBeginResult = {
  redirectUrl: string;
  bindingCookie: { name: string; value: string; sameSite: 'lax' | 'none' };
};

export type SsoCompleteInput = {
  routeOrgId: string;
  query?: URLSearchParams;
  form?: Record<string, string>;
  bindingCookie: string | undefined;
};

export type SsoCompleteResult =
  | { ok: true; org: OrgRow; assertion: SsoAssertion }
  | { ok: false; orgId: string | null; cause: SsoErrorCode; email?: string | null };

export interface SsoProvider {
  readonly protocol: SsoProtocol;
  /** O1-O4 / S1-S2: the IdP URL to redirect to; writes the flow record. Throws SsoBeginError on a failure. */
  begin(org: OrgRow, cfg: SsoConfig, input: SsoBeginInput): Promise<SsoBeginResult>;
  /** O5-O7 / S4-S6: every check, starting with flow.orgId === routeOrgId; never throws for an IdP-side failure. */
  complete(flow: SsoFlowRecord, input: SsoCompleteInput): Promise<SsoCompleteResult>;
}

/** A begin that cannot redirect to the IdP (discovery failed, a needed key is missing). */
export class SsoBeginError extends Error {
  readonly code: SsoErrorCode;
  constructor(code: SsoErrorCode, message?: string) {
    super(message ?? `sso begin failed: ${code}`);
    this.name = 'SsoBeginError';
    this.code = code;
  }
}

/** C0 / C1 controls, zero-width and bidi formatting characters (built from code points). */
const INVISIBLE_RANGES: [number, number][] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

/** Sanitised display name: control characters removed, whitespace collapsed, at most 80 chars; null when empty. */
export function sanitiseName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 80) : null;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/** Lower-cased email when it looks like one and is at most 254 chars; null otherwise. */
export function normaliseAssertedEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (e.length === 0 || e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

/** At most 200 groups of at most 256 chars each, strings only. */
export function normaliseGroups(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return list
    .filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= 256)
    .slice(0, 200);
}
