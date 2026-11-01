/**
 * Phase E section 3: the per-org SSO configuration stored in `org.sso_config`, the flow record, verified domains and
 * the pure helpers both the api and the console use (domain normalisation, `safeReturnTo`, JIT role mapping, the TXT
 * record names). Browser-safe: IDNA goes through the WHATWG URL parser, never `node:url`.
 */
import { z } from 'zod';
import {
  JIT_ROLES,
  PACKAGE_TIERS,
  PUBLIC_EMAIL_DOMAINS,
  SAML_NAMEID_FORMATS,
  SSO_DOMAIN_STATUSES,
  SSO_ERROR_CODES,
  SSO_PROTOCOLS,
  type JitRole,
  type SsoProtocol,
} from '../enums.js';
import { hex64Schema, isoTimestampSchema, uuidSchema } from '../schemas/common.js';

/** An absolute http(s) URL; `https:` is enforced by the egress guard (section 2.2 G1), `http:` only under EGRESS_ALLOW_HTTP. */
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((s) => /^https?:\/\//i.test(s), 'expected an http(s) URL');
const claimName = z.string().regex(/^[A-Za-z0-9_:./-]{1,128}$/, 'expected a claim or attribute name');
/** RSA >= 2048 and not expired is checked at save (`400 sso_cert_invalid`), not here. */
const pemCertificate = z
  .string()
  .max(16384)
  .regex(/^-----BEGIN CERTIFICATE-----/, 'expected a PEM certificate');

export const GOOGLE_ISSUER = 'https://accounts.google.com';

export const ssoRequiredClaimSchema = z.strictObject({
  /** e.g. `hd` (Google Workspace domain), `tid` (Entra tenant id). */
  name: claimName,
  /** The claim (a string, or an array of strings) must hold one of these. */
  values: z.array(z.string().min(1).max(256)).min(1).max(20),
});
export type SsoRequiredClaim = z.infer<typeof ssoRequiredClaimSchema>;

export const ssoOidcConfigSchema = z.strictObject({
  /** Discovery: `${issuer}/.well-known/openid-configuration`. */
  issuer: httpsUrl,
  clientId: z.string().min(1).max(255),
  /** `none` = a public client, PKCE only. */
  tokenEndpointAuth: z.enum(['client_secret_basic', 'client_secret_post', 'none']),
  /** Must contain `openid` (superRefine of ssoConfigSchema). */
  scopes: z
    .array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/, 'expected an OAuth scope token'))
    .min(1)
    .max(10),
  emailClaim: claimName,
  nameClaim: claimName,
  groupsClaim: claimName.nullable(),
  /** At least one when `issuer` is https://accounts.google.com (superRefine). */
  requiredClaims: z.array(ssoRequiredClaimSchema).max(5),
});
export type SsoOidcConfig = z.infer<typeof ssoOidcConfigSchema>;

export const ssoSamlConfigSchema = z.strictObject({
  idpEntityId: z.string().min(1).max(1024),
  /** The IdP's HTTP-Redirect SingleSignOnService. */
  ssoUrl: httpsUrl,
  /** RSA only; more than one during IdP key rotation. */
  idpCertificates: z.array(pemCertificate).min(1).max(3),
  nameIdFormat: z.enum(SAML_NAMEID_FORMATS),
  /** null = the NameID is the email (requires `nameIdFormat: 'email'`). */
  emailAttribute: claimName.nullable(),
  nameAttribute: claimName.nullable(),
  groupsAttribute: claimName.nullable(),
  signAuthnRequests: z.boolean(),
  /** The Assertion signature is ALWAYS required; this adds the Response's. */
  wantResponseSigned: z.boolean(),
  clockSkewSec: z.number().int().min(0).max(300),
});
export type SsoSamlConfig = z.infer<typeof ssoSamlConfigSchema>;

export const ssoJitSchema = z.strictObject({
  enabled: z.boolean(),
  /** Never `org_admin`. */
  defaultRole: z.enum(JIT_ROLES),
  /** Validated against org.plan_tier at save (`400 tier_not_licensed`) and again at provisioning. */
  defaultSeatTier: z.enum(PACKAGE_TIERS),
  groupRoles: z
    .array(z.strictObject({ group: z.string().min(1).max(256), role: z.enum(JIT_ROLES) }))
    .max(50),
});
export type SsoJit = z.infer<typeof ssoJitSchema>;

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export const ssoConfigSchema = z
  .strictObject({
    v: z.literal(1),
    protocol: z.enum(SSO_PROTOCOLS),
    enabled: z.boolean(),
    /** "Sign in with <displayName>". */
    displayName: z.string().min(1).max(60),
    /** Non-null iff protocol === 'oidc'. */
    oidc: ssoOidcConfigSchema.nullable(),
    /** Non-null iff protocol === 'saml'. */
    saml: ssoSamlConfigSchema.nullable(),
    jit: ssoJitSchema,
    /** Section 3.8; default 12. */
    sessionMaxAgeHours: z.number().int().min(1).max(168),
  })
  .superRefine((c, ctx) => {
    if (c.protocol === 'oidc') {
      if (!c.oidc) ctx.addIssue({ code: 'custom', path: ['oidc'], message: 'oidc is required when protocol is oidc' });
      if (c.saml) ctx.addIssue({ code: 'custom', path: ['saml'], message: 'saml must be null when protocol is oidc' });
    } else {
      if (!c.saml) ctx.addIssue({ code: 'custom', path: ['saml'], message: 'saml is required when protocol is saml' });
      if (c.oidc) ctx.addIssue({ code: 'custom', path: ['oidc'], message: 'oidc must be null when protocol is saml' });
    }
    if (c.oidc) {
      if (!c.oidc.scopes.includes('openid'))
        ctx.addIssue({ code: 'custom', path: ['oidc', 'scopes'], message: "scopes must contain 'openid'" });
      if (sameIssuer(c.oidc.issuer, GOOGLE_ISSUER) && c.oidc.requiredClaims.length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['oidc', 'requiredClaims'],
          message: 'a Google issuer needs at least one required claim (for example hd), so a consumer account cannot sign in',
        });
    }
    if (c.saml && c.saml.emailAttribute === null && c.saml.nameIdFormat !== 'email')
      ctx.addIssue({
        code: 'custom',
        path: ['saml', 'emailAttribute'],
        message: "emailAttribute may be null only with nameIdFormat 'email'",
      });
  });
export type SsoConfig = z.infer<typeof ssoConfigSchema>;

/** Parses a stored `org.sso_config`; null (never a throw) for null or a value that does not parse (section 3.1). */
export function parseSsoConfig(raw: unknown): SsoConfig | null {
  if (raw === null || raw === undefined) return null;
  const r = ssoConfigSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** What a protocol handler returns after every check of section 3.4 / 3.5 passed. Never persisted whole. */
export type SsoAssertion = {
  protocol: SsoProtocol;
  /** OIDC `iss`, SAML IdP entity id. */
  issuer: string;
  /** OIDC `sub`, SAML NameID (persistent or email). */
  subject: string;
  /** Lower-cased. */
  email: string;
  /** OIDC `email_verified`; null when absent or SAML. */
  emailVerified: boolean | null;
  /** Sanitised, <= 80. */
  name: string | null;
  /** <= 200, each <= 256. */
  groups: string[];
  /** SAML SessionNotOnOrAfter; caps the session (section 3.8). */
  notOnOrAfter: Date | null;
};

const sha256HexSchema = hex64Schema;
const flowCommon = {
  v: z.literal(1),
  orgId: uuidSchema,
  bindingHash: sha256HexSchema,
  returnTo: z.string().max(512),
  test: z.boolean(),
  /** The acting org_admin of a test flow (section 3.9 `POST /sso/test`); null otherwise. */
  actingUserId: uuidSchema.nullable(),
  createdAt: isoTimestampSchema,
};

/**
 * Section 3.4 O3 / 3.5 S2: the flow record `ia:sso:flow:<sha256Hex(state | relayState)>` held in presence for
 * `LIMITS.ssoFlowTtlSec`.
 */
export const ssoFlowRecordSchema = z.discriminatedUnion('protocol', [
  z.strictObject({
    ...flowCommon,
    protocol: z.literal('oidc'),
    codeVerifier: z.string().min(43).max(128),
    nonce: z.string().min(1).max(128),
  }),
  z.strictObject({
    ...flowCommon,
    protocol: z.literal('saml'),
    /** The AuthnRequest `ID`. */
    requestId: z.string().min(1).max(256),
  }),
]);
export type SsoFlowRecord = z.infer<typeof ssoFlowRecordSchema>;

/** Section 3.9 `SsoDomain`. */
export const ssoDomainSchema = z.strictObject({
  id: uuidSchema,
  domain: z.string().max(253),
  status: z.enum(SSO_DOMAIN_STATUSES),
  /** `_indiansassist.<domain>`. */
  txtName: z.string().max(270),
  /** `ia-verify=<token>`. */
  txtValue: z.string().regex(/^ia-verify=[0-9a-f]{32}$/),
  verifiedAt: isoTimestampSchema.nullable(),
  lastCheckedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});
export type SsoDomain = z.infer<typeof ssoDomainSchema>;

// ---------- helpers ----------

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Section 3.2a / 2.6 `domain_invalid`: IDNA-to-ASCII, lower-case, then at least two labels, each 1..63 of `[a-z0-9-]`
 * not starting or ending with `-`, an alphabetic last label, 253 chars at most; no wildcard, port, path or trailing
 * dot. Returns null for anything that is not such a host name. No public-suffix list is consulted.
 */
export function normaliseDomain(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '' || raw.length > 253 * 4 || /[\s/\\?#@:*%]/.test(raw)) return null;
  let host: string;
  try {
    host = new URL(`http://${raw}/`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  if (!/^[a-z]+$/.test(labels[labels.length - 1]!)) return null;
  return host;
}

/** The normalised domain of an email address (after the last `@`), or null. */
export function emailDomainOf(email: string): string | null {
  if (typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normaliseDomain(email.slice(at + 1));
}

/** True for a public mail domain (`PUBLIC_EMAIL_DOMAINS`, section 3.2a); the input is normalised first. */
export function isPublicEmailDomain(domain: string): boolean {
  const d = normaliseDomain(domain) ?? domain.trim().toLowerCase();
  return (PUBLIC_EMAIL_DOMAINS as readonly string[]).includes(d);
}

export const DEFAULT_RETURN_TO = '/app';

/**
 * Section 3.4 O1: keeps `return_to` only when it is a relative path under `/app` (`/app`, `/app/...`, `/app?...`,
 * `/app#...`), with no `//`, no backslash, no control character and at most 512 chars; anything else is `/app`.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_RETURN_TO;
  if (value.length === 0 || value.length > 512) return DEFAULT_RETURN_TO;
  if (!/^\/app(?:$|[/?#])/.test(value)) return DEFAULT_RETURN_TO;
  if (value.includes('//') || value.includes('\\')) return DEFAULT_RETURN_TO;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return DEFAULT_RETURN_TO;
  return value;
}

/** Section 3.6 rule 4: the first `groupRoles` entry whose group the assertion carries, else `defaultRole`. */
export function resolveJitRole(jit: Pick<SsoJit, 'defaultRole' | 'groupRoles'>, groups: readonly string[]): JitRole {
  const held = new Set(groups);
  for (const m of jit.groupRoles) if (held.has(m.group)) return m.role;
  return jit.defaultRole;
}

/** Section 3.2b: the TXT record name of a domain proof. */
export function ssoTxtName(domain: string): string {
  return `_indiansassist.${domain}`;
}

/** Section 3.2b: the exact TXT record value of a domain proof. */
export function ssoTxtValue(token: string): string {
  return `ia-verify=${token}`;
}

/** `org.sso_last_test` (section 3.9 `POST /sso/test`), as stored. */
export const ssoLastTestSchema = z.strictObject({
  at: isoTimestampSchema,
  ok: z.boolean(),
  cause: z.enum(SSO_ERROR_CODES).nullable(),
  userId: uuidSchema,
  matchedSelf: z.boolean(),
});
export type SsoLastTest = z.infer<typeof ssoLastTestSchema>;
