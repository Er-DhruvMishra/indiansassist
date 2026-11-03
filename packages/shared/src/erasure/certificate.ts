/**
 * Phase F section 5.5 (docs/specs/phase-f-contracts.md): the signed erasure certificate, signed exactly like the
 * residency report (E section 6.3): the region's token-signing key over
 * `utf8("ia-erasure-v1\n") || canonicalJsonBytes(certificate without "signature")`, verified over the RAW parsed JSON
 * with the key looked up by `kid`. The certificate contains no name, slug, email or reason.
 */
import { z } from 'zod';
import { canonicalJsonBytes, sha256Hex } from '../canonical.js';
import { DATA_FLOW_KINDS } from '../enums.js';
import { kidOf, publicKeyFromSeed, publicKeyToBase64url, signBytes, verifyBytesSync, type PublicKeyLike } from '../crypto.js';
import { utf8Encode } from '../encoding.js';
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

const SIG_DOMAIN_PREFIX = utf8Encode(`${ERASURE_SIG_DOMAIN}\n`);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The certificate minus its `signature` member (a shallow copy; nothing else is touched). The copy has no prototype,
 * so a `__proto__` member of parsed JSON stays an own member and is signed and verified like any other.
 */
function withoutSignature(cert: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(cert)) if (k !== 'signature') rest[k] = cert[k];
  return rest;
}

/**
 * `utf8("ia-erasure-v1\n") || canonicalJsonBytes(certificate without "signature")`. The domain prefix keeps an erasure
 * signature from ever being valid as a token, checkpoint or residency report signature (they sign bare canonical
 * JSON or another domain). Throws CanonicalJsonError for a value outside the canonical JSON subset.
 */
export function erasureSigningInput(cert: Record<string, unknown>): Uint8Array {
  const body = canonicalJsonBytes(withoutSignature(cert));
  const out = new Uint8Array(SIG_DOMAIN_PREFIX.length + body.length);
  out.set(SIG_DOMAIN_PREFIX, 0);
  out.set(body, SIG_DOMAIN_PREFIX.length);
  return out;
}

/**
 * Signs a certificate with the region's token-signing seed and returns it with `signature` (one it already carries is
 * replaced). `sig` is pure Ed25519 over the whole signing input; `sha256` is the hex digest of the same input (for
 * matching a printout, not what is signed); `pub` is the base64url public key of `kid`.
 */
export async function signErasureCertificate(
  cert: UnsignedErasureCertificate,
  seedHex: string,
  kid: string,
): Promise<ErasureCertificate> {
  const bare = withoutSignature(cert as unknown as Record<string, unknown>);
  const input = erasureSigningInput(bare);
  const pub = await publicKeyFromSeed(seedHex);
  if (kidOf(pub) !== kid) throw new Error('signErasureCertificate: kid does not belong to the signing seed');
  const signature: ErasureSignature = {
    alg: 'Ed25519',
    domain: ERASURE_SIG_DOMAIN,
    kid,
    pub: publicKeyToBase64url(pub),
    sig: await signBytes(input, seedHex),
    sha256: sha256Hex(input),
    signedAt: new Date().toISOString(),
  };
  return { ...(bare as unknown as UnsignedErasureCertificate), signature };
}

/**
 * Verifies over the RAW parsed JSON (`JSON.parse` of the file) minus its `signature` member, never over a
 * schema-parsed copy (which would drop a field added after signing). `kid` is looked up in `keys`; `signature.pub` is
 * never trusted alone. A `sha256` that is not the digest of the signing input, or a `pub` other than the listed key of
 * `kid`, is `bad_signature`. Never throws.
 */
export function verifyErasureCertificate(raw: unknown, keys: readonly PublicKeyLike[]): ErasureVerifyResult {
  try {
    if (!isPlainRecord(raw)) return { ok: false, cause: 'malformed' };
    const sig = raw.signature;
    if (!isPlainRecord(sig)) return { ok: false, cause: 'malformed' };
    if (
      sig.alg !== 'Ed25519' ||
      sig.domain !== ERASURE_SIG_DOMAIN ||
      typeof sig.kid !== 'string' ||
      typeof sig.sig !== 'string' ||
      typeof sig.sha256 !== 'string' ||
      (sig.pub !== undefined && typeof sig.pub !== 'string')
    )
      return { ok: false, cause: 'malformed' };
    const kid = sig.kid;
    const key = keys.find((k) => k.kid === kid);
    if (!key) return { ok: false, cause: 'unknown_kid' };
    let input: Uint8Array;
    try {
      input = erasureSigningInput(raw);
    } catch {
      return { ok: false, cause: 'malformed' };
    }
    if (!verifyBytesSync(input, sig.sig, kid, [key])) return { ok: false, cause: 'bad_signature' };
    if (sig.sha256 !== sha256Hex(input)) return { ok: false, cause: 'bad_signature' };
    if (typeof sig.pub === 'string') {
      const listed = typeof key.pub === 'string' ? key.pub : publicKeyToBase64url(key.pub);
      if (sig.pub !== listed) return { ok: false, cause: 'bad_signature' };
    }
    return { ok: true };
  } catch {
    return { ok: false, cause: 'malformed' };
  }
}
