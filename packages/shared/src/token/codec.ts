/**
 * Signed support token codec (contracts section 3.1, steps 1-3 and 5 of section 3.5).
 * Format: `ia1.<kid>.<base64url(canonical payload)>.<base64url(ed25519 signature)>`.
 */
import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import { base64urlDecode, base64urlEncode, randomBytes, utf8Decode, utf8Encode } from '../encoding.js';
import { kidOf, publicKeyFromSeed, signBytes, verifyBytes, type PublicKeyLike } from '../crypto.js';
import { PACKAGE_TIERS, TOKEN_TYPES, type PackageTier, type TokenType } from '../enums.js';
import { REGIONS, type Region } from '../regions.js';

export type TokenPayload = {
  v: 1;
  tid: string;
  org: string;
  by: string;
  tier: PackageTier;
  typ: TokenType;
  reg: Region;
  iat: number;
  exp: number;
  nonce: string;
};

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const unixSeconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Exactly the ten payload fields, no extras (strict). */
export const tokenPayloadSchema = z.strictObject({
  v: z.literal(1),
  tid: uuid,
  org: uuid,
  by: uuid,
  tier: z.enum(PACKAGE_TIERS),
  typ: z.enum(TOKEN_TYPES),
  reg: z.enum(REGIONS),
  iat: unixSeconds,
  exp: unixSeconds,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'nonce must be base64url of 16 bytes'),
});

export const TOKEN_PREFIX = 'ia1';
const KID_RE = /^[0-9a-f]{16}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export type SignedToken = { compact: string; payload: TokenPayload; signature: string; kid: string };

/** Signs a payload with a 32-byte hex seed; the nonce (16 random bytes) and `v` are added here. */
export async function signToken(payload: Omit<TokenPayload, 'v' | 'nonce'>, seedHex: string): Promise<SignedToken> {
  const full: TokenPayload = { v: 1, ...payload, nonce: base64urlEncode(randomBytes(16)) };
  const checked = tokenPayloadSchema.parse(full) as TokenPayload;
  const payloadBytes = utf8Encode(canonicalJson(checked));
  const signature = await signBytes(payloadBytes, seedHex);
  const kid = kidOf(await publicKeyFromSeed(seedHex));
  const compact = `${TOKEN_PREFIX}.${kid}.${base64urlEncode(payloadBytes)}.${signature}`;
  return { compact, payload: checked, signature, kid };
}

export type ParsedToken = { ok: true; kid: string; payload: TokenPayload; signature: string; payloadBytes: Uint8Array };
export type ParseTokenResult = ParsedToken | { ok: false; error: 'token_malformed' };

const MALFORMED = { ok: false, error: 'token_malformed' } as const;

/** Steps 1-2 of section 3.5: structure, canonical payload bytes, exact field set and types. */
export function parseToken(compact: string): ParseTokenResult {
  if (typeof compact !== 'string' || compact.length > 4096) return MALFORMED;
  const parts = compact.split('.');
  if (parts.length !== 4) return MALFORMED;
  const [prefix, kid, payloadPart, signature] = parts as [string, string, string, string];
  if (prefix !== TOKEN_PREFIX || !KID_RE.test(kid)) return MALFORMED;
  if (!SEGMENT_RE.test(payloadPart) || !SEGMENT_RE.test(signature)) return MALFORMED;
  let payloadBytes: Uint8Array;
  let json: string;
  let value: unknown;
  try {
    payloadBytes = base64urlDecode(payloadPart);
    json = utf8Decode(payloadBytes);
    value = JSON.parse(json);
  } catch {
    return MALFORMED;
  }
  const parsed = tokenPayloadSchema.safeParse(value);
  if (!parsed.success) return MALFORMED;
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch {
    return MALFORMED;
  }
  if (canonical !== json) return MALFORMED;
  return { ok: true, kid, payload: parsed.data as TokenPayload, signature, payloadBytes };
}

/** Step 3: Ed25519 verify with the key whose kid equals `parsed.kid`; false when no key has that kid. */
export async function verifyTokenSignature(
  parsed: { kid: string; payloadBytes: Uint8Array; signature: string },
  keys: readonly PublicKeyLike[],
): Promise<boolean> {
  return verifyBytes(parsed.payloadBytes, parsed.signature, parsed.kid, keys);
}

/** Step 5: `iat <= now + 60` and `now < exp` (unix seconds). */
export function isTokenTimeValid(payload: Pick<TokenPayload, 'iat' | 'exp'>, nowSec: number): boolean {
  return payload.iat <= nowSec + 60 && nowSec < payload.exp;
}

export type TokenCheckResult =
  | { ok: true; kid: string; payload: TokenPayload }
  | { ok: false; error: 'token_malformed' }
  | { ok: false; error: 'token_bad_signature' }
  | { ok: false; error: 'token_gone'; status: 'expired' };

/**
 * Client-side pre-check (join page): steps 1-3 and 5 with the published keys. The server check is
 * authoritative (steps 4 and 6-8 need the node's region set and database).
 */
export async function checkToken(
  compact: string,
  keys: readonly PublicKeyLike[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<TokenCheckResult> {
  const parsed = parseToken(compact);
  if (!parsed.ok) return parsed;
  if (!(await verifyTokenSignature(parsed, keys))) return { ok: false, error: 'token_bad_signature' };
  if (!isTokenTimeValid(parsed.payload, nowSec)) return { ok: false, error: 'token_gone', status: 'expired' };
  return { ok: true, kid: parsed.kid, payload: parsed.payload };
}

/**
 * Section 3.3 input normalisation: trim; `ia1.` prefix => compact token with all whitespace removed;
 * otherwise strip non-digits and require exactly 12 digits => short code; anything else => null.
 */
export function normaliseTokenInput(
  s: string,
): { kind: 'compact'; value: string } | { kind: 'short_code'; value: string } | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (trimmed.startsWith(`${TOKEN_PREFIX}.`)) return { kind: 'compact', value: trimmed.replace(/\s+/g, '') };
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length === 12) return { kind: 'short_code', value: digits };
  return null;
}
