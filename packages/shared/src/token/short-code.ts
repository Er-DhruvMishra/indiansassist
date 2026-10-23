/**
 * Short code generation, display and check digit validation.
 *
 * Contracts section 3.3 as amended by section 15 X12: the 12th digit is a Luhn (mod 10) check digit over the
 * first 11, so a mistyped digit or an adjacent transposition is caught client side before a lookup. The issued
 * code space is therefore 9 x 10^10. `normaliseTokenInput` still accepts any 12 digits; the server rejects a
 * Luhn-invalid code before any database access (it can never match an issued code), and every such rejection
 * still counts towards the per-node miss budget (S3) so the check digit never makes guessing cheaper.
 */
import { randomBytes } from '../encoding.js';

export const SHORT_CODE_LENGTH = 12;

/** Luhn check digit for a string of digits (the digit that makes `digits + check` Luhn-valid). */
export function luhnCheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new Error('digits only');
  let sum = 0;
  // Rightmost digit of `digits` is doubled because the check digit will be appended after it.
  for (let i = digits.length - 1, double = true; i >= 0; i--, double = !double) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** True when the full digit string (payload + check digit) passes Luhn. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  return luhnCheckDigit(digits.slice(0, -1)) === digits.charCodeAt(digits.length - 1) - 48;
}

/** Uniform random digits by rejection sampling (`min`..9). */
function randomDigit(next: () => number, min: number): number {
  const span = 10 - min;
  const limit = 256 - (256 % span);
  for (;;) {
    const b = next();
    if (b < limit) return min + (b % span);
  }
}

/**
 * Generates a 12-digit code: first digit 1-9, ten uniform digits, then the Luhn check digit.
 * `random` (n => n CSPRNG bytes) is injectable for tests; it defaults to Web Crypto.
 */
export function generateShortCode(random: (n: number) => Uint8Array = randomBytes): string {
  let pool = random(32);
  let pos = 0;
  const next = (): number => {
    if (pos >= pool.length) {
      pool = random(32);
      pos = 0;
    }
    return pool[pos++]!;
  };
  let body = String(randomDigit(next, 1));
  for (let i = 0; i < 10; i++) body += String(randomDigit(next, 0));
  return body + String(luhnCheckDigit(body));
}

/** 12 digits, first digit 1-9, Luhn-valid check digit. Spaces are not accepted (normalise first). */
export function isValidShortCode(code: string): boolean {
  return /^[1-9]\d{11}$/.test(code) && luhnValid(code);
}

/** `482193657710` -> `4821 9365 7710` (dashboard and Desk display). */
export function formatShortCode(code: string): string {
  if (!/^\d{12}$/.test(code)) throw new Error('short code must be 12 digits');
  return `${code.slice(0, 4)} ${code.slice(4, 8)} ${code.slice(8, 12)}`;
}
