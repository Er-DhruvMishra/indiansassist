/**
 * Phase F section 6 (gate section 15.5 "shared"): the camera code normalisation (Crockford, section 6.2a) and the
 * `ia.cam` security code vector (section 6.5), recomputed here with node:crypto as an independent implementation.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_CODE_RE,
  cameraCommit,
  cameraSecFrameSchema,
  cameraSecurityCode,
  formatCameraCode,
  normaliseCameraCode,
} from '../src/index.js';

const OFFER_FPR =
  'sha-256 3A:96:6B:4C:1F:0E:27:58:AB:CD:EF:01:23:45:67:89:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78';
const ANSWER_FPR =
  'sha-256 F0:E1:D2:C3:B4:A5:96:87:78:69:5A:4B:3C:2D:1E:0F:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
const nA = Uint8Array.from({ length: 32 }, (_, i) => i);
const nP = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

function reference(offer: string, answer: string, a: Uint8Array, p: Uint8Array): string {
  const h = createHash('sha256')
    .update(Buffer.from(`ia-cam-v1\n${offer}\n${answer}`, 'utf8'))
    .update(a)
    .update(p)
    .digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

describe('camera code (section 6.2a)', () => {
  it('normalises case, separators and the Crockford look-alikes', () => {
    expect(normaliseCameraCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normaliseCameraCode(' 0123 4567 89ab ')).toBe('0123456789AB');
    expect(normaliseCameraCode('oOiI-lL00-1111')).toBe('00111100' + '1111');
    expect(normaliseCameraCode('ABCD-EFGH-JKMU')).toBeNull(); // U is not a Crockford symbol
    expect(normaliseCameraCode('ABCD-EFGH-JKM')).toBeNull();
    expect(normaliseCameraCode('ABCD-EFGH-JKMNP')).toBeNull();
    expect(normaliseCameraCode('x'.repeat(40))).toBeNull();
    expect(formatCameraCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
    expect(() => formatCameraCode('abcdefghjkmn')).toThrow();
    expect(CAMERA_CODE_RE.test('0123456789AB')).toBe(true);
  });
});

describe('ia.cam security code (section 6.5)', () => {
  it('matches an independent sha256 computation, reduced mod 10^6 and zero-padded', () => {
    const code = cameraSecurityCode(OFFER_FPR, ANSWER_FPR, nA, nP);
    expect(code).toMatch(/^\d{6}$/);
    expect(code).toBe(reference(OFFER_FPR, ANSWER_FPR, nA, nP));
  });

  it('is the same on both sides for one set of fingerprints and nonces, and changes with any input', () => {
    const phone = cameraSecurityCode(OFFER_FPR, ANSWER_FPR, nA, nP);
    const assist = cameraSecurityCode(OFFER_FPR, ANSWER_FPR, Uint8Array.from(nA), Uint8Array.from(nP));
    expect(assist).toBe(phone);
    const other = Uint8Array.from(nP);
    other[0] = other[0]! ^ 1;
    const cases: [string, string, Uint8Array, Uint8Array][] = [
      [ANSWER_FPR, OFFER_FPR, nA, nP],
      [OFFER_FPR, ANSWER_FPR, nP, nA],
      [OFFER_FPR, ANSWER_FPR, nA, other],
    ];
    for (const c of cases) expect(cameraSecurityCode(...c)).toBe(reference(...c));
    expect(new Set([phone, ...cases.map((c) => cameraSecurityCode(...c))]).size).toBeGreaterThan(1);
  });

  it('commits to nA with hex(sha256(nA)) and refuses nonces that are not 32 bytes', () => {
    expect(cameraCommit(nA)).toBe(createHash('sha256').update(nA).digest('hex'));
    expect(() => cameraCommit(new Uint8Array(31))).toThrow();
    expect(() => cameraSecurityCode(OFFER_FPR, ANSWER_FPR, nA, new Uint8Array(33))).toThrow();
  });

  it('frames are strict: commit hex64, nonce and reveal base64url of 32 bytes', () => {
    expect(cameraSecFrameSchema.safeParse({ t: 'commit', c: 'a'.repeat(64) }).success).toBe(true);
    expect(cameraSecFrameSchema.safeParse({ t: 'nonce', n: 'A'.repeat(43) }).success).toBe(true);
    expect(cameraSecFrameSchema.safeParse({ t: 'reveal', n: 'A'.repeat(43), extra: 1 }).success).toBe(false);
    expect(cameraSecFrameSchema.safeParse({ t: 'nonce', n: 'A'.repeat(44) }).success).toBe(false);
    expect(cameraSecFrameSchema.safeParse({ t: 'commit', c: 'A'.repeat(64) }).success).toBe(false);
  });
});
