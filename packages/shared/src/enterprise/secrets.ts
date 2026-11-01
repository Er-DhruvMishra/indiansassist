/**
 * Phase E section 2.1: the wire view of an org secret. Read from stored columns (`*_set_at`, `*_fp`), never by opening
 * the secret; the plaintext is write-only and never appears in a response.
 */
import { z } from 'zod';
import { isoTimestampSchema } from '../schemas/common.js';

/** First 8 lower-case hex of `HMAC-SHA256(ORG_SECRETS_FP_KEY, plaintext)`. */
export const secretFingerprintSchema = z.string().regex(/^[0-9a-f]{8}$/, 'expected 8 lower-case hex chars');

export const secretStatusSchema = z.strictObject({
  set: z.boolean(),
  setAt: isoTimestampSchema.nullable(),
  fingerprint: secretFingerprintSchema.nullable(),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>;

/** The status of an unset secret. */
export const SECRET_UNSET: SecretStatus = Object.freeze({ set: false, setAt: null, fingerprint: null }) as SecretStatus;
