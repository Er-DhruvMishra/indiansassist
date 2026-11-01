/**
 * Phase D sealing (conventions table "Device sealing key"): the server seals a one-use secret (a wake target's MAC,
 * AMT credentials, a vault secret) to exactly one device's X25519 key with the C section 1 primitives:
 * `key = HKDF-SHA256(ikm = X25519(eph, kex), salt = nonce, info = utf8("ia-seal-v1") || purpose)`,
 * `ct = XChaCha20-Poly1305(key, nonce, plaintext, aad = utf8(deviceId))`. Mirrored by `ia_core::seal` (the device
 * opens in Rust; `openSealed` here is for tests and the smoke's simulated device).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';
import { base64urlDecode, base64urlEncode, randomBytes, utf8Encode } from '../encoding.js';
import { SEAL_PURPOSES, type SealPurpose } from '../enums.js';

export const SEAL_INFO_PREFIX = 'ia-seal-v1';

/** `Sealed` (base64url fields): ephemeral public key, 24-byte nonce, ciphertext with the 16-byte tag. */
export const sealedSchema = z.strictObject({
  epk: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url of 32 bytes'),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/, 'base64url of 24 bytes'),
  ct: z.string().regex(/^[A-Za-z0-9_-]{22,}$/, 'base64url ciphertext'),
});
export type Sealed = z.infer<typeof sealedSchema>;

function sealKey(shared: Uint8Array, nonce: Uint8Array, purpose: SealPurpose): Uint8Array {
  if (!(SEAL_PURPOSES as readonly string[]).includes(purpose)) throw new Error(`unknown seal purpose ${String(purpose)}`);
  const info = utf8Encode(`${SEAL_INFO_PREFIX}${purpose}`);
  return hkdf(sha256, shared, nonce, info, 32);
}

/**
 * Seals `plaintext` to the device whose X25519 public key is `kexPublicKey` (base64url). `opts` fixes the ephemeral
 * secret and nonce (test vectors only).
 */
export function sealToDevice(
  kexPublicKey: string,
  deviceId: string,
  purpose: SealPurpose,
  plaintext: Uint8Array | string,
  opts: { ephSecret?: Uint8Array; nonce?: Uint8Array } = {},
): Sealed {
  const kex = base64urlDecode(kexPublicKey);
  if (kex.length !== 32) throw new Error('kex public key must be 32 bytes');
  const eph = opts.ephSecret ?? randomBytes(32);
  const nonce = opts.nonce ?? randomBytes(24);
  if (nonce.length !== 24) throw new Error('seal nonce must be 24 bytes');
  const shared = x25519.getSharedSecret(eph, kex);
  const key = sealKey(shared, nonce, purpose);
  const pt = typeof plaintext === 'string' ? utf8Encode(plaintext) : plaintext;
  const ct = xchacha20poly1305(key, nonce, utf8Encode(deviceId)).encrypt(pt);
  return { epk: base64urlEncode(x25519.getPublicKey(eph)), nonce: base64urlEncode(nonce), ct: base64urlEncode(ct) };
}

/** Opens a `Sealed` with the device's X25519 secret; throws on any tampering or a wrong device / purpose. */
export function openSealed(kexSecret: Uint8Array, deviceId: string, purpose: SealPurpose, sealed: Sealed): Uint8Array {
  const s = sealedSchema.parse(sealed);
  const nonce = base64urlDecode(s.nonce);
  const shared = x25519.getSharedSecret(kexSecret, base64urlDecode(s.epk));
  const key = sealKey(shared, nonce, purpose);
  return xchacha20poly1305(key, nonce, utf8Encode(deviceId)).decrypt(base64urlDecode(s.ct));
}

/** The base64url X25519 public key of a 32-byte secret (device side; tests and the smoke). */
export function kexPublicKeyOf(secret: Uint8Array): string {
  return base64urlEncode(x25519.getPublicKey(secret));
}

/**
 * Rule 8.2c: XChaCha20-Poly1305 at rest under the region fleet data key, serialised `<keyId>.<nonce>.<ct>` (base64url)
 * so the key can rotate; `aad` binds the value to its row (the device id). Server-side only.
 */
export function sealAtRest(key: Uint8Array, keyId: string, plaintext: string, aad: string): string {
  if (key.length !== 32) throw new Error('the fleet data key is 32 bytes');
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(keyId)) throw new Error('bad key id');
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce, utf8Encode(aad)).encrypt(utf8Encode(plaintext));
  return `${keyId}.${base64urlEncode(nonce)}.${base64urlEncode(ct)}`;
}

/** Opens a `sealAtRest` value with the key named by its key id; throws on an unknown key or tampering. */
export function openAtRest(keys: ReadonlyMap<string, Uint8Array>, value: string, aad: string): string {
  const [keyId, nonce, ct] = value.split('.');
  const key = keyId ? keys.get(keyId) : undefined;
  if (!key || !nonce || !ct) throw new Error('unknown fleet data key or malformed value');
  return new TextDecoder().decode(xchacha20poly1305(key, base64urlDecode(nonce), utf8Encode(aad)).decrypt(base64urlDecode(ct)));
}
