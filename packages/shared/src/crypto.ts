/**
 * Ed25519 via @noble/ed25519 v2 with sha512 wired from @noble/hashes (contracts section 3.1), plus key
 * helpers. Browser-safe: no Node-only APIs. Both the async API (`signAsync` / `verifyAsync`) and the sync
 * API (used by the synchronous `verifyChain`) are enabled.
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { base64urlDecode, base64urlEncode, bytesToHex, hexToBytes } from './encoding.js';

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => sha512(ed.etc.concatBytes(...messages));
ed.etc.sha512Async = async (...messages: Uint8Array[]): Promise<Uint8Array> => sha512(ed.etc.concatBytes(...messages));

export { ed };

/** Public key set entry: 32 raw public key bytes and their kid. */
export type PublicKeyEntry = { kid: string; pub: Uint8Array };

/** A public key whose `pub` may also be base64url (JSONL export header, well-known document). */
export type PublicKeyLike = { kid: string; pub: Uint8Array | string };

const SEED_RE = /^[0-9a-fA-F]{64}$/;

/** Decodes a 32-byte Ed25519 seed given as 64 hex chars. Throws otherwise. */
export function seedFromHex(seedHex: string): Uint8Array {
  if (!SEED_RE.test(seedHex)) throw new Error('signing seed must be 64 hex chars (32 bytes)');
  return hexToBytes(seedHex);
}

/** First 16 hex chars of sha256 over the 32 raw public key bytes. */
export function kidOf(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error('public key must be 32 bytes');
  return bytesToHex(sha256(pub)).slice(0, 16);
}

export async function publicKeyFromSeed(seedHex: string): Promise<Uint8Array> {
  return ed.getPublicKeyAsync(seedFromHex(seedHex));
}

export function publicKeyToBase64url(pub: Uint8Array): string {
  return base64urlEncode(pub);
}

/** Decodes a base64url public key (43 chars, 32 bytes). Throws otherwise. */
export function publicKeyFromBase64url(s: string): Uint8Array {
  const bytes = base64urlDecode(s);
  if (bytes.length !== 32) throw new Error('public key must be 32 bytes');
  return bytes;
}

/** Builds a PublicKeyEntry (kid derived) from raw bytes or base64url. */
export function publicKeyEntry(pub: Uint8Array | string): PublicKeyEntry {
  const bytes = typeof pub === 'string' ? publicKeyFromBase64url(pub) : pub;
  return { kid: kidOf(bytes), pub: bytes };
}

function toPubBytes(pub: Uint8Array | string): Uint8Array | null {
  try {
    return typeof pub === 'string' ? publicKeyFromBase64url(pub) : pub.length === 32 ? pub : null;
  } catch {
    return null;
  }
}

/** Signs `message` with the seed; returns the base64url signature. */
export async function signBytes(message: Uint8Array, seedHex: string): Promise<string> {
  return base64urlEncode(await ed.signAsync(message, seedFromHex(seedHex)));
}

function sigBytes(signature: string): Uint8Array | null {
  try {
    const sig = base64urlDecode(signature);
    return sig.length === 64 ? sig : null;
  } catch {
    return null;
  }
}

/** Async verify of a base64url signature against the key in `keys` whose kid matches. Never throws. */
export async function verifyBytes(
  message: Uint8Array,
  signature: string,
  kid: string,
  keys: readonly PublicKeyLike[],
): Promise<boolean> {
  const key = keys.find((k) => k.kid === kid);
  if (!key) return false;
  const pub = toPubBytes(key.pub);
  const sig = sigBytes(signature);
  if (!pub || !sig) return false;
  try {
    return await ed.verifyAsync(sig, message, pub);
  } catch {
    return false;
  }
}

/** Synchronous variant of verifyBytes (sha512Sync is wired above). Never throws. */
export function verifyBytesSync(
  message: Uint8Array,
  signature: string,
  kid: string,
  keys: readonly PublicKeyLike[],
): boolean {
  const key = keys.find((k) => k.kid === kid);
  if (!key) return false;
  const pub = toPubBytes(key.pub);
  const sig = sigBytes(signature);
  if (!pub || !sig) return false;
  try {
    return ed.verify(sig, message, pub);
  } catch {
    return false;
  }
}
