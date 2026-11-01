/**
 * Phase D device signatures and sealing (docs/specs/phase-d-contracts.md section 3.8, conventions table): the eight
 * domains against `fixtures/fleet/signatures.json`, the length-prefixed framing, and `sealToDevice` / `openSealed`
 * round trip, tamper detection and vectors (`fixtures/fleet/seal.json`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_SIG_DOMAINS,
  bytesToHex,
  deviceSigningInput,
  hexToBytes,
  openSealed,
  sealToDevice,
  signDeviceInput,
  verifyDeviceSignature,
  deviceSigInput,
  utf8Decode,
  type Sealed,
  type SealPurpose,
} from '../src/index.js';

const read = <T>(n: string) => JSON.parse(readFileSync(new URL(`./fixtures/fleet/${n}`, import.meta.url), 'utf8')) as T;

type SigVectors = {
  keys: { identitySeedHex: string; devicePublicKey: string; newIdentitySeedHex: string; newPublicKey: string };
  vectors: { domain: string; fields: Record<string, unknown>; signingInputHex: string; sig: string }[];
};
type SealVectors = { kexSecretHex: string; kexPublicKey: string; deviceId: string; vectors: { purpose: SealPurpose; plaintext: string; ephSecretHex: string; sealed: Sealed }[] };

const BUILD: Record<string, (f: never) => Uint8Array> = {
  'ia-enroll-v1': deviceSigInput.enroll,
  'ia-dev-v1': deviceSigInput.hello,
  'ia-rot-v1': deviceSigInput.rotate,
  'ia-rot-new-v1': deviceSigInput.rotateNew,
  'ia-dereg-v1': deviceSigInput.deregister,
  'ia-tamper-v1': deviceSigInput.tamper,
  'ia-action-v1': deviceSigInput.action,
  'ia-sas-v1': deviceSigInput.sas,
};

describe('device signatures (section 3.8)', () => {
  const sv = read<SigVectors>('signatures.json');
  it('the fixture covers all eight domains', () => {
    expect(sv.vectors.map((v) => v.domain).sort()).toEqual([...DEVICE_SIG_DOMAINS].sort());
  });
  for (const v of sv.vectors) {
    it(`${v.domain}: signing input and signature reproduce, and verify`, () => {
      const input = BUILD[v.domain]!(v.fields as never);
      expect(bytesToHex(input)).toBe(v.signingInputHex);
      const seed = hexToBytes(v.domain === 'ia-rot-new-v1' ? sv.keys.newIdentitySeedHex : sv.keys.identitySeedHex);
      expect(signDeviceInput(input, seed)).toBe(v.sig);
      const pub = v.domain === 'ia-rot-new-v1' ? sv.keys.newPublicKey : sv.keys.devicePublicKey;
      expect(verifyDeviceSignature(input, v.sig, pub)).toBe(true);
      const flipped = new Uint8Array(input);
      flipped[flipped.length - 1]! ^= 1;
      expect(verifyDeviceSignature(flipped, v.sig, pub)).toBe(false);
    });
  }
  it('framing: utf8(domain) then 4-byte big-endian lengths; integers decimal, base64url decoded', () => {
    const b = deviceSigningInput('ia-dereg-v1', [{ uuid: '00000000-0000-4000-8000-000000000000' }, { int: 42 }, { b64u: 'AAEC' }]);
    const head = new TextEncoder().encode('ia-dereg-v1');
    expect(bytesToHex(b.slice(0, head.length))).toBe(bytesToHex(head));
    expect(bytesToHex(b.slice(head.length, head.length + 4))).toBe('00000024');
    // ... 0x00000002 "42" then 0x00000003 00 01 02
    expect(bytesToHex(b.slice(-13))).toBe('00000002343200000003000102');
    expect(() => deviceSigningInput('ia-dev-v1', [{ uuid: 'NOT-A-UUID' }])).toThrow();
    expect(() => deviceSigInput.hello({ deviceId: '00000000-0000-4000-8000-000000000000', serverChallenge: 'AAEC', nonce: 'AAEC' })).toThrow();
  });
  it('a bad signature or key never throws', () => {
    expect(verifyDeviceSignature(new Uint8Array(1), 'x', 'y')).toBe(false);
  });
});

describe('sealing (conventions table)', () => {
  const sv = read<SealVectors>('seal.json');
  const kexSecret = hexToBytes(sv.kexSecretHex);
  for (const v of sv.vectors) {
    it(`${v.purpose}: vector reproduces and opens`, () => {
      const sealed = sealToDevice(sv.kexPublicKey, sv.deviceId, v.purpose, v.plaintext, {
        ephSecret: hexToBytes(v.ephSecretHex),
        nonce: Uint8Array.from(Buffer.from(v.sealed.nonce, 'base64url')),
      });
      expect(sealed).toEqual(v.sealed);
      expect(utf8Decode(openSealed(kexSecret, sv.deviceId, v.purpose, v.sealed))).toBe(v.plaintext);
    });
  }
  it('random seal round-trips; wrong device, purpose or a flipped byte fails', () => {
    const s = sealToDevice(sv.kexPublicKey, sv.deviceId, 'wake-mac', '0a1b2c3d4e5f');
    expect(utf8Decode(openSealed(kexSecret, sv.deviceId, 'wake-mac', s))).toBe('0a1b2c3d4e5f');
    expect(() => openSealed(kexSecret, '00000000-0000-4000-8000-000000000000', 'wake-mac', s)).toThrow();
    expect(() => openSealed(kexSecret, sv.deviceId, 'amt-cred', s)).toThrow();
    const ct = Buffer.from(s.ct, 'base64url');
    ct[0]! ^= 1;
    expect(() => openSealed(kexSecret, sv.deviceId, 'wake-mac', { ...s, ct: ct.toString('base64url') })).toThrow();
  });
});
