#!/usr/bin/env node
/**
 * Generates packages/shared/test/fixtures/agent/sec-vectors.json: cross-language test vectors for the Phase C secure channel
 * (contracts section 1.3: commit round, transcript, HKDF keys, SAS, confirm MACs, frame format), plus the
 * shared helpers the native clients port (canonicalJson, sanitiseFileName, normaliseTokenInput, isValidShortCode,
 * fingerprintFromSdp). Every value is computed here independently of Tink and RustCrypto: X25519 and
 * ChaCha20-Poly1305 come from Node's OpenSSL, HChaCha20 (the XChaCha extension) is implemented below and checked
 * against draft-irtf-cfrg-xchacha-03, and the helper outputs come from the real @indiansassist/shared build.
 *
 * Run from the repo root: node apps/android/tools/gen-phase-c-vectors.mjs  (needs packages/shared/dist)
 */
import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const shared = await import(new URL(`file:///${resolve(root, 'packages/shared/dist/index.js').replace(/\\/g, '/')}`));
const { canonicalJson, sanitiseFileName, normaliseTokenInput, isValidShortCode, opIdFor } = shared;

const hex = (b) => Buffer.from(b).toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();
const hmac = (k, b) => createHmac('sha256', k).update(b).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');

// ---------- X25519 (raw keys through DER wrappers) ----------
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const privKey = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const pubRaw = (raw) => createPublicKey(privKey(raw)).export({ format: 'der', type: 'spki' }).subarray(12);
const x25519 = (skRaw, pkRaw) =>
  diffieHellman({ privateKey: privKey(skRaw), publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, pkRaw]), format: 'der', type: 'spki' }) });

// ---------- HKDF-SHA256 (RFC 5869) ----------
const hkdfExtract = (salt, ikm) => hmac(salt, ikm);
function hkdfExpand(prk, info, len) {
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  for (let i = 1; okm.length < len; i++) {
    t = hmac(prk, Buffer.concat([t, utf8(info), Buffer.from([i])]));
    okm = Buffer.concat([okm, t]);
  }
  return okm.subarray(0, len);
}

// ---------- XChaCha20-Poly1305 = HChaCha20 subkey + IETF ChaCha20-Poly1305 ----------
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
function hchacha20(key, nonce16) {
  const s = new Uint32Array(16);
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = nonce16.readUInt32LE(i * 4);
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  [0, 1, 2, 3, 12, 13, 14, 15].forEach((w, i) => out.writeUInt32LE(s[w], i * 4));
  return out;
}
function xchachaSeal(key, nonce24, plaintext, aad) {
  const sub = hchacha20(key, nonce24.subarray(0, 16));
  const n12 = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const c = createCipheriv('chacha20-poly1305', sub, n12, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

// Self-check against draft-irtf-cfrg-xchacha-03 (section 2.2.1 and A.3.1) before emitting anything.
const draftKey = Buffer.from('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f', 'hex');
const draftNonce = Buffer.from('404142434445464748494a4b4c4d4e4f5051525354555657', 'hex');
const draftAad = Buffer.from('50515253c0c1c2c3c4c5c6c7', 'hex');
const draftPt = utf8("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
const hTest = hchacha20(Buffer.from([...Array(32).keys()]), Buffer.from('000000090000004a0000000031415927', 'hex'));
if (hex(hTest) !== '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc') throw new Error('HChaCha20 self-check failed');
const draftCt = xchachaSeal(draftKey, draftNonce, draftPt, draftAad);
if (!hex(draftCt).startsWith('bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb') || !hex(draftCt).endsWith('c0875924c1c7987947deafd8780acf49'))
  throw new Error('XChaCha20-Poly1305 self-check failed');

// ---------- section 1.3 ----------
const SUITE = 'x25519-xchacha20poly1305-hkdfsha256';
const LABEL_IDS = { 'ia.control': 1, 'ia.file': 2, 'ia.playbook': 3, 'ia.chat': 4, 'ia.annot': 5, 'ia.ctrl': 6 };
const commitHash = (side, epk, fpr) => b64u(sha256(utf8(canonicalJson({ side, suite: SUITE, epk, fpr }))));

function handshake({ name, sessionId, gen, deskSeed, assistSeed, deskFpr, assistFpr, ts }) {
  const sk = { desk: sha256(utf8(deskSeed)), assist: sha256(utf8(assistSeed)) };
  const fpr = { desk: deskFpr, assist: assistFpr };
  const side = {};
  for (const s of ['desk', 'assist']) {
    const epk = b64u(pubRaw(sk[s]));
    const h = commitHash(s, epk, fpr[s]);
    side[s] = {
      eskHex: hex(sk[s]),
      epk,
      fpr: fpr[s],
      h,
      commitPreimage: canonicalJson({ side: s, suite: SUITE, epk, fpr: fpr[s] }),
      commit: { t: 'sec.commit', v: 1, sessionId, side: s, h, gen, ts },
      hello: { t: 'sec.hello', v: 1, sessionId, side: s, suite: SUITE, epk, fpr: fpr[s], ts },
    };
  }
  const ss = x25519(sk.desk, Buffer.from(side.assist.epk, 'base64url'));
  const ss2 = x25519(sk.assist, Buffer.from(side.desk.epk, 'base64url'));
  if (!ss.equals(ss2)) throw new Error('X25519 disagreement');
  const transcript = canonicalJson({
    v: 1, sessionId, suite: SUITE, gen,
    desk: { h: side.desk.h, epk: side.desk.epk, fpr: side.desk.fpr },
    assist: { h: side.assist.h, epk: side.assist.epk, fpr: side.assist.fpr },
  });
  const T = sha256(utf8(transcript));
  const prk = hkdfExtract(T, ss);
  const kD2A = hkdfExpand(prk, 'ia-sec-v1 desk->assist', 32);
  const kA2D = hkdfExpand(prk, 'ia-sec-v1 assist->desk', 32);
  const kConf = hkdfExpand(prk, 'ia-sec-v1 confirm', 32);
  const sasRaw = hkdfExpand(prk, 'ia-sec-v1 sas', 4);
  const sas = String(sasRaw.readUInt32BE(0) % 1000000).padStart(6, '0');
  const mac = (s) => b64u(hmac(kConf, Buffer.concat([utf8(s), T])));
  return {
    name, sessionId, gen, suite: SUITE, desk: side.desk, assist: side.assist,
    expected: {
      ssHex: hex(ss), transcript, transcriptHashHex: hex(T), prkHex: hex(prk),
      kD2AHex: hex(kD2A), kA2DHex: hex(kA2D), kConfHex: hex(kConf), sasRawHex: hex(sasRaw), sas,
      sasDisplay: `${sas.slice(0, 3)} ${sas.slice(3)}`,
      deskConfirm: { t: 'sec.confirm', mac: mac('desk'), ts },
      assistConfirm: { t: 'sec.confirm', mac: mac('assist'), ts },
    },
    keys: { kD2A, kA2D },
  };
}

function frameNonce(labelId, dir, gen, seq) {
  const n = Buffer.alloc(24);
  n[0] = labelId; n[1] = dir; n.writeUInt16BE(gen, 2); n.writeBigUInt64BE(BigInt(seq), 16);
  return n;
}
function frameAad(sessionId, label, flags) {
  return Buffer.concat([utf8('ia-sec-v1'), utf8(sessionId), Buffer.from([0]), utf8(label), Buffer.from([0]), Buffer.from([1, flags])]);
}
function frame(hs, { label, direction, seq, text, binaryHex }) {
  const dir = direction === 'desk_to_assist' ? 0 : 1;
  const key = dir === 0 ? hs.keys.kD2A : hs.keys.kA2D;
  const flags = text !== undefined ? 1 : 0;
  const pt = text !== undefined ? utf8(text) : Buffer.from(binaryHex, 'hex');
  const nonce = frameNonce(LABEL_IDS[label], dir, hs.gen, seq);
  const aad = frameAad(hs.sessionId, label, flags);
  const header = Buffer.alloc(10);
  header[0] = 1; header[1] = flags; header.writeBigUInt64BE(BigInt(seq), 2);
  const fr = Buffer.concat([header, xchachaSeal(key, nonce, pt, aad)]);
  return {
    label, labelId: LABEL_IDS[label], direction, gen: hs.gen, seq, flags,
    ...(text !== undefined ? { plaintextUtf8: text } : { plaintextHex: binaryHex }),
    nonceHex: hex(nonce), aadHex: hex(aad), frameHex: hex(fr),
  };
}

const SESSION = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const FPR_D = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FPR_A = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const TS = 1793059200000;
const hs0 = handshake({ name: 'gen0', sessionId: SESSION, gen: 0, deskSeed: 'ia-vectors desk esk 0', assistSeed: 'ia-vectors assist esk 0', deskFpr: FPR_D, assistFpr: FPR_A, ts: TS });
const hs1 = handshake({ name: 'gen1-rebuild', sessionId: SESSION, gen: 1, deskSeed: 'ia-vectors desk esk 1', assistSeed: 'ia-vectors assist esk 1', deskFpr: FPR_D, assistFpr: FPR_A, ts: TS + 60000 });

const ctlReq = JSON.stringify({ t: 'ctl.req', id: 'r1', op: 'os.pointer', args: { monitorId: 1, kind: 'click', nx: 0.5, ny: 0.25, button: 0, modifiers: {} }, ts: TS });
const chunkHex = '0000000100000000' + hex(utf8('hello file chunk'));
const frames = [
  frame(hs0, { label: 'ia.control', direction: 'assist_to_desk', seq: 0, text: ctlReq }),
  frame(hs0, { label: 'ia.control', direction: 'desk_to_assist', seq: 0, text: JSON.stringify({ t: 'ctl.res', id: 'r1', ok: true, result: {}, ts: TS }) }),
  frame(hs0, { label: 'ia.file', direction: 'desk_to_assist', seq: 7, binaryHex: chunkHex }),
  frame(hs0, { label: 'ia.playbook', direction: 'desk_to_assist', seq: 1, text: '{"t":"pb.end"}' }),
  frame(hs0, { label: 'ia.chat', direction: 'desk_to_assist', seq: 2, text: JSON.stringify({ t: 'chat', msgId: '0b5f3c1e-8a2d-4c6f-9e1b-7d3a5c2e4f60', from: 'desk', text: 'नमस्ते, hello', ts: TS }) }),
  frame(hs0, { label: 'ia.annot', direction: 'assist_to_desk', seq: 3, text: JSON.stringify({ t: 'annot', shape: 'clear', monitorId: 1, ts: TS }) }),
  frame(hs0, { label: 'ia.ctrl', direction: 'assist_to_desk', seq: 0, text: JSON.stringify({ t: 'recording.state', recording: true, ts: TS }) }),
  frame(hs0, { label: 'ia.ctrl', direction: 'desk_to_assist', seq: 4294967296, text: '{}' }),
  frame(hs1, { label: 'ia.control', direction: 'assist_to_desk', seq: 0, text: ctlReq }),
];

// Negative cases: what a receiver must answer (sec.fail reason).
const tampered = Buffer.from(frames[0].frameHex, 'hex'); tampered[tampered.length - 1] ^= 0x01;
const badFlags = Buffer.from(frames[0].frameHex, 'hex'); badFlags[1] = 0x03;
const wrongEpk = b64u(pubRaw(sha256(utf8('ia-vectors attacker esk'))));
const negative = [
  { name: 'hello does not match commit', kind: 'hello', side: 'assist', committedH: hs0.assist.h, hello: { ...hs0.assist.hello, epk: wrongEpk }, expect: 'commit' },
  { name: 'fingerprint mismatch', kind: 'fingerprint', side: 'assist', hello: hs0.assist.hello, observedRemoteFpr: FPR_D, expect: 'fingerprint' },
  { name: 'unknown suite', kind: 'hello', side: 'assist', committedH: hs0.assist.h, hello: { ...hs0.assist.hello, suite: 'x25519-aes256gcm' }, expect: 'suite' },
  { name: 'all-zero shared secret (low-order point)', kind: 'key', eskHex: hs0.desk.eskHex, peerEpk: b64u(Buffer.alloc(32)), expect: 'key' },
  { name: 'bad confirm mac', kind: 'mac', mac: b64u(Buffer.alloc(32, 7)), expect: 'mac' },
  { name: 'tampered tag', kind: 'frame', label: 'ia.control', direction: 'assist_to_desk', gen: 0, expectedSeq: 0, frameHex: hex(tampered), expect: 'decrypt' },
  { name: 'reserved flag bits set', kind: 'frame', label: 'ia.control', direction: 'assist_to_desk', gen: 0, expectedSeq: 0, frameHex: hex(badFlags), expect: 'decrypt' },
  { name: 'seq skips ahead', kind: 'frame', label: 'ia.file', direction: 'desk_to_assist', gen: 0, expectedSeq: 6, frameHex: frames[2].frameHex, expect: 'replay' },
  { name: 'seq replayed', kind: 'frame', label: 'ia.file', direction: 'desk_to_assist', gen: 0, expectedSeq: 8, frameHex: frames[2].frameHex, expect: 'replay' },
  { name: 'frame under the wrong label', kind: 'frame', label: 'ia.chat', direction: 'desk_to_assist', gen: 0, expectedSeq: 7, frameHex: frames[2].frameHex, expect: 'decrypt' },
];

// ---------- helpers the native clients port ----------
const canonicalCases = [
  { b: 2, a: 1, c: [3, 'x', null, true] },
  { 'é': 'ü', e: 'tab\tnl\nquote"back\\', z: '\u0001\u001f\u007f' },
  { nested: { y: { b: [], a: {} }, x: -5 }, emoji: '😀', k: 0 },
  { B: 1, a: 2, _: 3, '10': 4, '9': 5 },
].map((value) => ({ value, canonical: canonicalJson(value) }));

const fileNameInputs = [
  ['report.pdf', 1], ['../../etc/passwd', 2], ['C:\\Windows\\system32\\evil.exe', 3], ['  ..hidden.txt', 4],
  ['con.txt', 5], ['LPT1', 6], ['aux.log.gz', 7], ['a   b\t\tc.doc', 8], ['', 9], ['...', 10], ['in\u202Eexe.txt', 11],
  ['inv?lid*name<>|".png', 12], ['zero\u200Bwidth.txt', 13], ['e\u0301te.txt', 14], [`${'x'.repeat(250)}.tar.gz`, 15],
  [`${'y'.repeat(300)}`, 16], ['photo 😀 2026.jpg', 17], ['trailing space .txt ', 18], ['nul', 19], ['COM9.txt', 20],
];
const fileNames = fileNameInputs.map(([name, fileId]) => ({ name, fileId, sanitised: sanitiseFileName(name, fileId) }));

const joinInputs = [
  'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln', '  ia1.3f9a1c2b4d5e6f70.eyJ2\n IjoxfQ.c2ln  ', '4821 9365 7715', '4821-9365-7715',
  '482193657715', '48219365771', '4821936577150', 'hello', '', 'IA1.abc',
];
const joinInput = joinInputs.map((input) => ({ input, normalised: normaliseTokenInput(input) }));
const shortCodes = ['482193657715', '482193657710', '082193657715', '48219365771a', '4821 9365 7715', '000000000000', '100000000008']
  .map((code) => ({ code, valid: isValidShortCode(code) }));

const fpBody = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const fpNorm = fpBody.replace(/:/g, '').toLowerCase();
const fingerprintFromSdp = [
  { name: 'session level', sdp: `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 ${fpBody}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fingerprint:sha-256 ${'00:'.repeat(31)}00\r\n`, fpr: fpNorm },
  { name: 'first media level', sdp: `v=0\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fingerprint:SHA-256 ${fpBody}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${'11:'.repeat(31)}11\r\n`, fpr: fpNorm },
  { name: 'LF line endings', sdp: `v=0\ns=-\na=fingerprint:sha-256 ${fpBody}\n`, fpr: fpNorm },
  { name: 'sha-1 only', sdp: `v=0\r\ns=-\r\na=fingerprint:sha-1 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01\r\n`, fpr: null },
  { name: 'none', sdp: 'v=0\r\ns=-\r\n', fpr: null },
];

const opIds = [[SESSION, 'r1'], [SESSION, 'lv-0'], ['00000000-0000-4000-8000-000000000000', 'x'.repeat(40)]].map(([sessionId, id]) => ({ sessionId, id, opId: opIdFor(sessionId, id) }));

const strip = ({ keys, ...rest }) => rest;
const out = {
  v: 1,
  description:
    'Phase C cross-language vectors (contracts section 1.3 and section 15). Generated by apps/android/tools/gen-phase-c-vectors.mjs from Node crypto and the @indiansassist/shared build; consumed by the TypeScript (packages/shared test/agent-sec.test.ts), Rust (ia-core tests/shared_vectors.rs) and Kotlin (Tink) tests. Hex is lower-case, base64url has no padding, keys are raw 32 bytes.',
  suite: SUITE,
  labelIds: LABEL_IDS,
  limits: { secFrameMaxBytes: 131072, secFrameHeaderBytes: 10, secTagBytes: 16, secHandshakeTimeoutMs: 10000 },
  xchacha20poly1305Draft: { keyHex: hex(draftKey), nonceHex: hex(draftNonce), aadHex: hex(draftAad), plaintextUtf8: draftPt.toString('utf8'), ciphertextAndTagHex: hex(draftCt) },
  handshakes: [strip(hs0), strip(hs1)],
  frames,
  negative,
  canonicalJson: canonicalCases,
  fileNames,
  joinInput,
  shortCodes,
  fingerprintFromSdp,
  opIds,
};
const target = resolve(root, 'packages/shared/test/fixtures/agent/sec-vectors.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${target}: ${frames.length} frames, ${negative.length} negative, sas gen0 ${hs0.expected.sas}, gen1 ${hs1.expected.sas}`);
