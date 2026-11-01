#!/usr/bin/env node
// Writes packages/shared/test/fixtures/fleet/*.json (docs/specs/phase-d-contracts.md section 3.8 and the sealing
// convention) from fixed keys with the BUILT @indiansassist/shared: the eight device signature domains (signing input
// hex + Ed25519 signature) and sealing vectors (fixed ephemeral secret and nonce). Both the TS tests and the Rust
// `ia_core::devsig` / `ia_core::seal` tests reproduce them. `--check` fails when the committed files differ.
//
//   pnpm --filter @indiansassist/shared build && node scripts/gen-fleet-fixtures.mjs [--check]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShared } from './smoke/shared.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages', 'shared', 'test', 'fixtures', 'fleet');
const s = await loadShared();

const hex = (b) => Buffer.from(b).toString('hex');
const fill = (n, v) => new Uint8Array(n).fill(v);
const b64u = (b) => s.base64urlEncode(b);

const identitySeed = fill(32, 0x11);
const newIdentitySeed = fill(32, 0x22);
const kexSecret = fill(32, 0x33);
const newKexSecret = fill(32, 0x44);
const deviceId = '0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a';
const sessionId = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const tokenId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const actionId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const devicePublicKey = s.devicePublicKeyOf(identitySeed);
const newPublicKey = s.devicePublicKeyOf(newIdentitySeed);
const deviceKexPublicKey = s.kexPublicKeyOf(kexSecret);
const newKexPublicKey = s.kexPublicKeyOf(newKexSecret);
const serverChallenge = b64u(fill(32, 0x55));
const nonce = b64u(fill(16, 0x66));
const rotationNonce = b64u(fill(16, 0x77));
const oldKeyId = s.kidOf(s.base64urlDecode(devicePublicKey));
const tamperEvent = { id: '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901', cause: 'stopped', at: '2026-11-01T10:00:00.000Z', detail: 'service stopped by SYSTEM' };

const cases = [
  ['ia-enroll-v1', identitySeed, s.deviceSigInput.enroll({ tokenId, devicePublicKey, deviceKexPublicKey }), { tokenId, devicePublicKey, deviceKexPublicKey }],
  ['ia-dev-v1', identitySeed, s.deviceSigInput.hello({ deviceId, serverChallenge, nonce }), { deviceId, serverChallenge, nonce }],
  ['ia-rot-v1', identitySeed, s.deviceSigInput.rotate({ deviceId, rotationNonce, newPublicKey, newKexPublicKey }), { deviceId, rotationNonce, newPublicKey, newKexPublicKey }],
  ['ia-rot-new-v1', newIdentitySeed, s.deviceSigInput.rotateNew({ deviceId, rotationNonce, oldKeyId }), { deviceId, rotationNonce, oldKeyId }],
  ['ia-dereg-v1', identitySeed, s.deviceSigInput.deregister({ deviceId, ts: 1793520000000, nonce }), { deviceId, ts: 1793520000000, nonce }],
  ['ia-tamper-v1', identitySeed, s.deviceSigInput.tamper({ deviceId, event: tamperEvent }), { deviceId, event: tamperEvent }],
  [
    'ia-action-v1',
    identitySeed,
    s.deviceSigInput.action({ deviceId, actionId, state: 'done', approvedBy: 'policy', result: { exit: 0, ranAs: 'admin' } }),
    { deviceId, actionId, state: 'done', approvedBy: 'policy', result: { exit: 0, ranAs: 'admin' } },
  ],
  [
    'ia-sas-v1',
    identitySeed,
    s.deviceSigInput.sas({ sessionId, gen: 1, sas: '042917', deskFpr: 'a'.repeat(64), assistFpr: 'b'.repeat(64) }),
    { sessionId, gen: 1, sas: '042917', deskFpr: 'a'.repeat(64), assistFpr: 'b'.repeat(64) },
  ],
];

const signatures = {
  v: 1,
  keys: {
    identitySeedHex: hex(identitySeed),
    devicePublicKey,
    newIdentitySeedHex: hex(newIdentitySeed),
    newPublicKey,
    kexSecretHex: hex(kexSecret),
    deviceKexPublicKey,
    newKexPublicKey,
    keyId: oldKeyId,
  },
  vectors: cases.map(([domain, seed, input, fields]) => ({
    domain,
    fields,
    signingInputHex: hex(input),
    sig: s.signDeviceInput(input, seed),
  })),
};

const seals = {
  v: 1,
  kexSecretHex: hex(kexSecret),
  kexPublicKey: deviceKexPublicKey,
  deviceId,
  vectors: [
    ['wake-mac', '0a1b2c3d4e5f', 0x01],
    ['amt-cred', '{"user":"admin","password":"P@ss"}', 0x02],
    ['vault-secret', 'secret-value-123', 0x03],
  ].map(([purpose, plaintext, v]) => {
    const ephSecret = fill(32, 0x80 + v);
    const nonceBytes = fill(24, 0x90 + v);
    return { purpose, plaintext, ephSecretHex: hex(ephSecret), sealed: s.sealToDevice(deviceKexPublicKey, deviceId, purpose, plaintext, { ephSecret, nonce: nonceBytes }) };
  }),
};

const files = { 'signatures.json': signatures, 'seal.json': seals };
const check = process.argv.includes('--check');
let bad = 0;
mkdirSync(outDir, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const text = JSON.stringify(value, null, 2) + '\n';
  const path = join(outDir, name);
  if (check) {
    let cur = '';
    try {
      cur = readFileSync(path, 'utf8');
    } catch {
      /* missing */
    }
    if (cur !== text) {
      console.error(`stale: ${path}`);
      bad++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote ${path}`);
  }
}
process.exit(bad ? 1 : 0);
