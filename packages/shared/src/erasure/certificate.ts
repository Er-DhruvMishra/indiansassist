/**
 * Phase F section 5.5 (docs/specs/phase-f-contracts.md): the signed erasure certificate. The foundation lands the
 * schema and the signing domain; the erasure stream fills `erasureSigningInput`, `signErasureCertificate` and
 * `verifyErasureCertificate` (signed exactly like the residency report, E section 6.3). The certificate contains no
 * name, slug, email or reason.
 */
import { z } from 'zod';
import { DATA_FLOW_KINDS } from '../enums.js';
import { notBuilt } from '../enterprise/not-built.js';
import type { PublicKeyLike } from '../crypto.js';
import { chainEntrySchema } from '../audit/export.js';
import {
  base64urlSchema,
  hex64Schema,
  isoTimestampSchema,
  kidSchema,
  regionSchema,
  uuidSchema,
  verifyFailureSchema,
} from '../schemas/common.js';

/** The domain prefix of the signing input (`utf8("ia-erasure-v1\n")`). */
export const ERASURE_SIG_DOMAIN = 'ia-erasure-v1' as const;

export const erasureSignatureSchema = z.strictObject({
  alg: z.literal('Ed25519'),
  domain: z.literal(ERASURE_SIG_DOMAIN),
  kid: kidSchema,
  pub: base64urlSchema,
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url Ed25519 signature'),
  sha256: hex64Schema,
  signedAt: isoTimestampSchema,
});
export type ErasureSignature = z.infer<typeof erasureSignatureSchema>;

export const erasureCertificateSchema = z.object({
  v: z.literal(1),
  erasureId: uuidSchema,
  orgId: uuidSchema,
  region: regionSchema,
  requestedAt: isoTimestampSchema,
  approvedAt: isoTimestampSchema,
  executedAt: isoTimestampSchema,
  completedAt: isoTimestampSchema,
  chain: z.strictObject({
    entries: z.number().int(),
    tail: hex64Schema,
    verified: z.boolean(),
    failure: verifyFailureSchema.nullable(),
    /** The `org.erased` entry itself, so its hash can be recomputed. */
    finalEntry: chainEntrySchema,
  }),
  /** Table or object kind -> count, e.g. `{ recordingObjects: 12, auth_session: 40 }`. */
  deleted: z.record(z.string(), z.number().int()),
  scrubbed: z.record(z.string(), z.number().int()),
  objectBytes: z.number().int(),
  /** The flow kinds enabled at execution (E section 6.2), so the customer can erase there. */
  externalFlows: z.array(z.enum(DATA_FLOW_KINDS)),
  /** 'database backups are kept for 35 days (operator setting)' | 'backup retention not stated'. */
  backups: z.string().max(200),
  signature: erasureSignatureSchema,
});
export type ErasureCertificate = z.infer<typeof erasureCertificateSchema>;
export type UnsignedErasureCertificate = Omit<ErasureCertificate, 'signature'>;

export type ErasureVerifyResult = { ok: boolean; cause?: 'unknown_kid' | 'bad_signature' | 'malformed' };

/** `utf8("ia-erasure-v1\n") || canonicalJsonBytes(certificate without "signature")` (erasure stream). */
export function erasureSigningInput(cert: Record<string, unknown>): Uint8Array {
  void cert;
  return notBuilt('erasure', 'erasureSigningInput');
}

/** Signs a certificate with the region's token-signing seed (erasure stream). */
export async function signErasureCertificate(
  cert: UnsignedErasureCertificate,
  seedHex: string,
  kid: string,
): Promise<ErasureCertificate> {
  void cert;
  void seedHex;
  void kid;
  return Promise.resolve(notBuilt('erasure', 'signErasureCertificate'));
}

/** Verifies over the RAW parsed JSON with the key looked up by `kid`; never throws (erasure stream). */
export function verifyErasureCertificate(raw: unknown, keys: readonly PublicKeyLike[]): ErasureVerifyResult {
  void raw;
  void keys;
  return notBuilt('erasure', 'verifyErasureCertificate');
}
