/** REST schemas of the SSO routes (docs/specs/phase-e-contracts.md section 3.9). */
import { z } from 'zod';
import { LIMITS, SSO_ERROR_CODES, SSO_PROTOCOLS } from '../enums.js';
import { secretStatusSchema } from '../enterprise/secrets.js';
import { ssoConfigSchema, ssoDomainSchema } from '../enterprise/sso.js';
import { isoTimestampSchema, uuidSchema } from './common.js';

/** `POST /auth/sso/discover`. */
export const ssoDiscoverRequestSchema = z.strictObject({ email: z.string().trim().min(1).max(254) });

/** Section 3.3: depends on the domain only, never on whether the email exists. */
export const ssoDiscoverySchema = z.strictObject({
  mode: z.enum(['sso_required', 'sso_available', 'password']),
  displayName: z.string().max(60).optional(),
  beginUrl: z.string().max(2048).optional(),
});
export type SsoDiscovery = z.infer<typeof ssoDiscoverySchema>;

/** `GET /auth/sso/:orgSlug/info` (the section 3.4 O1 interstitial). */
export const ssoInfoSchema = z.strictObject({
  orgName: z.string(),
  displayName: z.string().max(60),
  protocol: z.enum(SSO_PROTOCOLS),
});
export type SsoInfo = z.infer<typeof ssoInfoSchema>;

/** `GET /orgs/current/sso` and the other admin replies (secrets as SecretStatus only). */
export const ssoSettingsSchema = z.strictObject({
  config: ssoConfigSchema.nullable(),
  required: z.boolean(),
  secrets: z.strictObject({ clientSecret: secretStatusSchema, spKey: secretStatusSchema }),
  sp: z.strictObject({
    entityId: z.string(),
    acsUrl: z.string(),
    metadataUrl: z.string(),
    /** Per org: `${API_ORIGIN}/api/v1/auth/sso/oidc/<orgId>/callback`. */
    oidcRedirectUri: z.string(),
    certPem: z.string().nullable(),
  }),
  domains: z.array(ssoDomainSchema),
  breakGlassUserIds: z.array(uuidSchema),
  lastTest: z
    .strictObject({
      at: isoTimestampSchema,
      ok: z.boolean(),
      cause: z.enum(SSO_ERROR_CODES).nullable(),
      matchedSelf: z.boolean(),
    })
    .nullable(),
});
export type SsoSettings = z.infer<typeof ssoSettingsSchema>;

/** `PUT /orgs/current/sso`: `clientSecret` absent = unchanged, null = cleared. */
export const ssoPutRequestSchema = z.strictObject({
  config: ssoConfigSchema,
  clientSecret: z.string().min(1).max(4096).nullable().optional(),
});
export type SsoPutRequest = z.infer<typeof ssoPutRequestSchema>;

/** `PATCH /orgs/current/sso/required`. */
export const ssoRequiredPatchSchema = z.strictObject({ required: z.boolean(), dryRun: z.boolean().optional() });

/** `PATCH /orgs/current/sso/required` reply: the settings plus the section 3.7a warning. */
export const ssoRequiredReplySchema = ssoSettingsSchema.extend({
  warnings: z.strictObject({ usersOutsideVerifiedDomains: z.number().int().nonnegative() }),
});

/** `PUT /orgs/current/sso/break-glass`. */
export const ssoBreakGlassPutSchema = z.strictObject({
  userIds: z.array(uuidSchema).max(LIMITS.ssoBreakGlassMax),
});

/** `POST /orgs/current/sso/domains` (the `domain_invalid` rule is the route's, so the error code is exact). */
export const ssoDomainCreateSchema = z.strictObject({ domain: z.string().trim().min(1).max(300) });

export const ssoDomainsPageSchema = z.strictObject({ items: z.array(ssoDomainSchema) });

export const ssoSpKeyReplySchema = z.strictObject({ certPem: z.string() });

export const ssoTestReplySchema = z.strictObject({ beginUrl: z.string().max(2048) });
