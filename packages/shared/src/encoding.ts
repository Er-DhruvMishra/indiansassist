/**
 * Browser-safe byte encodings: UTF-8, lower-case hex, base64url (RFC 4648 section 5, no padding), standard base64.
 * No Node-only APIs (no Buffer).
 */

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Strict UTF-8 decode; throws on invalid sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  return fatalDecoder.decode(bytes);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

/** Decodes hex (either case). Throws on odd length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  if (!HEX_RE.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    if (pad) out += '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]!;
    if (pad) out += '=';
  }
  return out;
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export function base64urlEncode(bytes: Uint8Array): string {
  return encode(bytes, B64URL_ALPHABET, false);
}

function decode(s: string, strict: boolean): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64URL_ALPHABET.indexOf(s[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (strict && acc !== 0) throw new Error('invalid base64url (non-canonical trailing bits)');
  return out;
}

/**
 * Strict base64url decode: alphabet `A-Z a-z 0-9 - _`, no padding, no whitespace, canonical trailing bits
 * (a string whose unused low bits are non-zero is rejected, so every byte string has exactly one encoding).
 */
export function base64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new Error('invalid base64url');
  return decode(s, true);
}

export function isBase64url(s: string): boolean {
  try {
    base64urlDecode(s);
    return true;
  } catch {
    return false;
  }
}

/** Standard base64 with padding (used for TURN credentials). */
export function base64Encode(bytes: Uint8Array): string {
  return encode(bytes, B64_ALPHABET, true);
}

/** Standard base64 decode (padding optional). Throws on invalid input. */
export function base64Decode(s: string): Uint8Array {
  const stripped = s.replace(/={1,2}$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(stripped) || stripped.length % 4 === 1) throw new Error('invalid base64');
  return decode(stripped.replace(/\+/g, '-').replace(/\//g, '_'), false);
}

/** Cryptographically secure random bytes via Web Crypto (present in browsers and Node >= 19). */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * Constant-time comparison of two strings or byte arrays. A length mismatch returns false (never throws).
 * Browser-safe; the api may equally use `crypto.timingSafeEqual` (contracts conventions table).
 */
export function constantTimeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = typeof a === 'string' ? utf8Encode(a) : a;
  const y = typeof b === 'string' ? utf8Encode(b) : b;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
