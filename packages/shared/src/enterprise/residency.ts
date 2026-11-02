/**
 * Phase E section 6: the data residency report additions and its signature. The foundation lands the schemas and
 * the signing domain; the residency stream fills `residencySigningInput`, `signResidencyReport` and
 * `verifyResidencyReport` (section 6.3).
 */
import { z } from 'zod';
import { AI_ACK_SCOPES, DATA_CATEGORIES, DATA_FLOW_KINDS, DATA_STORE_KINDS, LEAVES_REGION } from '../enums.js';
import { canonicalJsonBytes, sha256Hex } from '../canonical.js';
import { kidOf, publicKeyFromSeed, publicKeyToBase64url, signBytes, verifyBytesSync, type PublicKeyLike } from '../crypto.js';
import { utf8Encode } from '../encoding.js';
import { base64urlSchema, hex64Schema, isoTimestampSchema, kidSchema, regionSchema } from '../schemas/common.js';

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

const SIG_DOMAIN_PREFIX = utf8Encode(`${RESIDENCY_SIG_DOMAIN}\n`);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The report minus its `signature` member (a shallow copy; nothing else is touched). The copy has no prototype, so a
 * `__proto__` member of parsed JSON stays an own member and is signed and verified like any other.
 */
function withoutSignature(report: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(report)) if (k !== 'signature') rest[k] = report[k];
  return rest;
}

/**
 * Section 6.3b: `utf8("ia-residency-v1\n") || canonicalJsonBytes(report without "signature")`. The domain prefix keeps
 * a report signature from ever being valid as a token or an audit checkpoint signature (both sign bare canonical
 * JSON). Throws CanonicalJsonError for a value outside the canonical JSON subset (a fraction, for example).
 */
export function residencySigningInput(report: Record<string, unknown>): Uint8Array {
  const body = canonicalJsonBytes(withoutSignature(report));
  const out = new Uint8Array(SIG_DOMAIN_PREFIX.length + body.length);
  out.set(SIG_DOMAIN_PREFIX, 0);
  out.set(body, SIG_DOMAIN_PREFIX.length);
  return out;
}

/**
 * Section 6.3b: signs a report with the region token-signing seed and returns it with `signature` (a `signature` it
 * already carries is replaced). `sig` is pure Ed25519 over the whole signing input; `sha256` is the hex digest of the
 * same input (for matching a printout, not what is signed); `pub` is the base64url public key of `kid`.
 */
export async function signResidencyReport<T extends Record<string, unknown>>(
  report: T,
  seedHex: string,
  kid: string,
): Promise<T & { signature: ResidencySignature }> {
  const input = residencySigningInput(report);
  const pub = await publicKeyFromSeed(seedHex);
  if (kidOf(pub) !== kid) throw new Error('signResidencyReport: kid does not belong to the signing seed');
  const signature: ResidencySignature = {
    alg: 'Ed25519',
    domain: RESIDENCY_SIG_DOMAIN,
    kid,
    pub: publicKeyToBase64url(pub),
    sig: await signBytes(input, seedHex),
    sha256: sha256Hex(input),
    signedAt: new Date().toISOString(),
  };
  return { ...(withoutSignature(report) as T), signature };
}

/**
 * Section 6.3c: verifies a report over the RAW parsed JSON (`JSON.parse` of the file) minus its `signature` member,
 * never over a schema-parsed copy (`residencyReportSchema` strips unknown keys, so a field added after signing would
 * be ignored). `kid` is looked up in `keys`; `signature.pub` is never trusted alone. The unsigned convenience fields
 * must agree too, so a printout cannot be matched to a report through an edited `sha256` or `pub`: a `sha256` that is
 * not the digest of the signing input, or a `pub` other than the listed key of `kid`, is `bad_signature`. Never throws.
 */
export function verifyResidencyReport(raw: unknown, keys: readonly PublicKeyLike[]): ResidencyVerifyResult {
  try {
    if (!isPlainRecord(raw)) return { ok: false, cause: 'malformed' };
    const sig = raw.signature;
    if (!isPlainRecord(sig)) return { ok: false, cause: 'malformed' };
    if (
      sig.alg !== 'Ed25519' ||
      sig.domain !== RESIDENCY_SIG_DOMAIN ||
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
      input = residencySigningInput(raw);
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
