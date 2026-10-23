/** Node crypto helpers: constant-time compares (conventions table), random secrets, HMAC presign (section 6.10). */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Constant-time string compare; a length mismatch is `false`, never an exception. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** `n` CSPRNG bytes as base64url. */
export function randomSecret(n = 32): string {
  return randomBytes(n).toString('base64url');
}

/** `HKDF-SHA256(ikm = SESSION_COOKIE_SECRET, salt = '', info = 'ia-presign', 32 bytes)`. */
export function derivePresignKey(cookieSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(cookieSecret, 'utf8'), Buffer.alloc(0), 'ia-presign', 32));
}

/** hex `HMAC-SHA256(presignKey, id + ':' + key + ':' + exp)`. */
export function presignSignature(presignKey: Buffer, id: string, key: string, exp: number): string {
  return createHmac('sha256', presignKey).update(`${id}:${key}:${exp}`).digest('hex');
}
