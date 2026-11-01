// node --test packaging/windows/tools/
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { test } from 'node:test';
import {
  base64urlDecode,
  canonicalJson,
  fromIaEnroll,
  kidOf,
  parseEnrollConfig,
  publicKeyRawFromSeed,
  shapeProblems,
  signEnrollConfig,
  signingInput,
  toIaEnroll,
  verifyEnrollConfig,
} from './enroll-config.mjs';

// RFC 8032 section 7.1, test 1.
const RFC_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC_PUB = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC_SIG_EMPTY =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

const FIELDS = {
  apiOrigin: 'https://in.indiansassist.example',
  signalUrl: 'wss://in.indiansassist.example/signal/device',
  region: 'in-mum',
  token: 'ia1.eyJ0eXAiOiJlbnJvbGxtZW50In0.c2ln',
  groupId: '0b7c6f2e-3a41-4f8e-9c1d-2e5f6a7b8c9d',
};

test('Ed25519 from a seed matches RFC 8032', () => {
  assert.equal(publicKeyRawFromSeed(RFC_SEED).toString('hex'), RFC_PUB);
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(RFC_SEED, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  assert.equal(sign(null, Buffer.alloc(0), key).toString('hex'), RFC_SIG_EMPTY);
});

test('canonical JSON sorts keys, keeps null, drops undefined', () => {
  assert.equal(
    canonicalJson({ b: 1, a: null, c: undefined, d: ['x', { z: true, y: 'é' }] }),
    '{"a":null,"b":1,"d":["x",{"y":"é","z":true}]}',
  );
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test('sign, verify and the signing input', () => {
  const text = signEnrollConfig(FIELDS, RFC_SEED);
  const cfg = parseEnrollConfig(text);
  assert.equal(cfg.kid, kidOf(Buffer.from(RFC_PUB, 'hex')));
  assert.equal(text, canonicalJson(cfg), 'the file is written canonically');
  assert.equal(signingInput(cfg).toString(), canonicalJson({ ...cfg, sig: undefined }));
  assert.ok(verifyEnrollConfig(cfg, [Buffer.from(RFC_PUB, 'hex')]));
  // Group binding: changing the group (or any field) breaks the signature.
  assert.ok(!verifyEnrollConfig({ ...cfg, groupId: null }, [Buffer.from(RFC_PUB, 'hex')]));
  // Unknown kid: no key to verify with.
  assert.ok(!verifyEnrollConfig(cfg, [publicKeyRawFromSeed('11'.repeat(32))]));
  // groupId null is signed as an explicit null.
  const noGroup = parseEnrollConfig(signEnrollConfig({ ...FIELDS, groupId: null }, RFC_SEED));
  assert.equal(noGroup.groupId, null);
  assert.ok(verifyEnrollConfig(noGroup, [Buffer.from(RFC_PUB, 'hex')]));
});

test('IA_ENROLL round trip is base64url of the verbatim file', () => {
  const text = signEnrollConfig(FIELDS, RFC_SEED);
  const value = toIaEnroll(text);
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.equal(fromIaEnroll(` ${value}\n`), text);
  assert.throws(() => base64urlDecode(`${value}=`));
  assert.throws(() => fromIaEnroll(Buffer.from('{"v":1}').toString('base64url')));
});

test('shape: strict keys and field rules mirror the custom action', () => {
  const cfg = parseEnrollConfig(signEnrollConfig(FIELDS, RFC_SEED));
  assert.deepEqual(shapeProblems(cfg), []);
  assert.ok(shapeProblems({ ...cfg, pubkeys: [] }).some((p) => p.includes('unknown key')));
  assert.ok(shapeProblems({ ...cfg, apiOrigin: 'https://x.example/path' }).length);
  assert.ok(shapeProblems({ ...cfg, apiOrigin: 'http://x.example' }).length);
  assert.deepEqual(
    shapeProblems({ ...cfg, apiOrigin: 'http://localhost:4000', signalUrl: 'ws://127.0.0.1:4000/signal/device' }),
    [],
  );
  assert.ok(shapeProblems({ ...cfg, signalUrl: 'wss://x.example/signal' }).length);
  assert.ok(shapeProblems({ ...cfg, groupId: 'NOT-A-UUID' }).length);
  const { groupId: _g, ...noGroupKey } = cfg;
  void _g;
  assert.ok(shapeProblems(noGroupKey).includes('missing groupId'), 'groupId must be present (null when none)');
  assert.ok(shapeProblems({ ...cfg, token: 'x'.repeat(4097) }).includes('token malformed'));
  assert.ok(shapeProblems({ ...cfg, kid: 'ABCDEF0123456789' }).length);
  assert.throws(() => parseEnrollConfig(JSON.stringify({ ...cfg, token: 'x'.repeat(17000) })), /larger than/);
});
