/**
 * Phase E section 6: the data residency report additions and its signature. The foundation lands the schemas and
 * the signing domain; the residency stream fills `residencySigningInput`, `signResidencyReport` and
 * `verifyResidencyReport`.
 */
import { z } from 'zod';
import { AI_ACK_SCOPES, DATA_CATEGORIES, DATA_FLOW_KINDS, DATA_STORE_KINDS, LEAVES_REGION } from '../enums.js';
import type { PublicKeyLike } from '../crypto.js';
import { base64urlSchema, hex64Schema, isoTimestampSchema, kidSchema, regionSchema } from '../schemas/common.js';
import { notBuilt } from './not-built.js';

/** Section 6.3b: the domain prefix of the signing input (`utf8("ia-residency-v1\n")`). */
export const RESIDENCY_SIG_DOMAIN = 'ia-residency-v1' as const;

export const dataCategorySchema = z.strictObject({
  category: z.enum(DATA_CATEGORIES),
  stores: z
    .array(
      z.strictObject({
        kind: z.enum(DATA_STORE_KINDS),
        region: regionSchema,
        /** e.g. 'PostgreSQL of in-mum', 'bucket ia-in-mum, prefix in-mum/<orgId>/'. */
        detail: z.string().max(200),
      }),
    )
    .max(4),
  /** Computed, e.g. 'until deleted by an org_admin' or '90 days (org setting)'. */
  retention: z.string().max(200),
  count: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
});
export type DataCategoryEntry = z.infer<typeof dataCategorySchema>;

export const dataFlowSchema = z.strictObject({
  kind: z.enum(DATA_FLOW_KINDS),
  /** 'Anthropic (Claude)', 'Zoho Desk (India DC)', 'Okta (OIDC)', 'SMTP relay'. */
  name: z.string().max(80),
  /** Host name only; never a path, query or credential. */
  host: z.string().max(255).nullable(),
  /** The data reaches a party other than this deployment. */
  leavesInfrastructure: z.boolean(),
  leavesRegion: z.enum(LEAVES_REGION),
  /** e.g. 'redacted session events and, if enabled, redacted chat'. */
  dataSent: z.string().max(200),
  enabled: z.boolean(),
  /** The chained change that enabled it. */
  since: isoTimestampSchema.nullable(),
  enabledBy: z.string().max(80).nullable(),
  acknowledgement: z
    .strictObject({ scope: z.enum(AI_ACK_SCOPES), by: z.string().max(80), at: isoTimestampSchema })
    .nullable(),
});
export type DataFlow = z.infer<typeof dataFlowSchema>;

/** Section 6.2 / 6.3: the report signature (`sig` over the domain-separated canonical JSON, not over `sha256`). */
export const residencySignatureSchema = z.strictObject({
  alg: z.literal('Ed25519'),
  domain: z.literal(RESIDENCY_SIG_DOMAIN),
  kid: kidSchema,
  /** base64url public key of `kid` (for humans and printouts; verification looks `kid` up in the key list). */
  pub: base64urlSchema,
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url Ed25519 signature'),
  sha256: hex64Schema,
  signedAt: isoTimestampSchema,
});
export type ResidencySignature = z.infer<typeof residencySignatureSchema>;

export type ResidencyVerifyResult = { ok: boolean; cause?: 'unknown_kid' | 'bad_signature' | 'malformed' };

/** Section 6.3b: `utf8("ia-residency-v1\n") || canonicalJsonBytes(report without "signature")` (residency stream). */
export function residencySigningInput(_report: Record<string, unknown>): Uint8Array {
  return notBuilt('residency', 'residencySigningInput');
}

/** Section 6.3b: signs a report with the region token-signing seed and returns it with `signature` (residency stream). */
export async function signResidencyReport<T extends Record<string, unknown>>(
  _report: T,
  _seedHex: string,
  _kid: string,
): Promise<T & { signature: ResidencySignature }> {
  return notBuilt('residency', 'signResidencyReport');
}

/** Section 6.3c: verifies over the raw parsed JSON, looking `kid` up in `keys`; never throws (residency stream). */
export function verifyResidencyReport(_raw: unknown, _keys: readonly PublicKeyLike[]): ResidencyVerifyResult {
  return notBuilt('residency', 'verifyResidencyReport');
}
