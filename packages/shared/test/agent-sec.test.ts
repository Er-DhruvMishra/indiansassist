/**
 * Phase C section 1.3 conformance: the TypeScript (@noble) implementation against the cross-language vectors
 * in test/fixtures/agent/sec-vectors.json, the same file the Rust (ia-core/tests/shared_vectors.rs) and Kotlin
 * (apps/android Vectors.kt) tests load. The vectors were generated from Node's OpenSSL, so a pass here is an
 * independent second implementation agreeing byte for byte.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SEC_LABEL_IDS,
  SEC_SUITE,
  SecChannel,
  SecError,
  base64urlEncode,
  bytesToHex,
  canonicalJson,
  commitHash,
  decodeSecFrame,
  deriveSecKeys,
  encodeSecFrame,
  fingerprintFromSdp,
  hexToBytes,
  isValidShortCode,
  normaliseTokenInput,
  opIdFor,
  sanitiseFileName,
  sasDisplay,
  secAad,
  secCommitSchema,
  secConfirmMac,
  secConfirmSchema,
  secHelloSchema,
  secNonce,
  secPublicKey,
  secSharedSecret,
  secTranscript,
  secTranscriptHash,
  utf8Encode,
  verifyHelloAgainstCommit,
  verifyPeerFingerprint,
  verifySecConfirm,
  type SecDirection,
  type SecEncryptedLabel,
  type SecFailReason,
} from '../src/index.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

/* eslint-disable @typescript-eslint/no-explicit-any */
const V: any = JSON.parse(readFileSync(new URL('./fixtures/agent/sec-vectors.json', import.meta.url), 'utf8'));

function reasonOf(fn: () => unknown): SecFailReason | 'none' {
  try {
    fn();
    return 'none';
  } catch (e) {
    if (e instanceof SecError) return e.reason;
    throw e;
  }
}

function keysFor(gen: number) {
  const h = V.handshakes.find((x: any) => x.gen === gen);
  return {
    kD2A: hexToBytes(h.expected.kD2AHex),
    kA2D: hexToBytes(h.expected.kA2DHex),
    sessionId: h.sessionId as string,
  };
}

describe('sec vectors: constants', () => {
  it('suite, label ids and limits agree', () => {
    expect(V.suite).toBe(SEC_SUITE);
    expect(V.labelIds).toEqual(SEC_LABEL_IDS);
    expect(V.limits.secFrameMaxBytes).toBe(131072);
  });

  it('XChaCha20-Poly1305 matches draft-irtf-cfrg-xchacha-03', () => {
    const d = V.xchacha20poly1305Draft;
    const ct = xchacha20poly1305(hexToBytes(d.keyHex), hexToBytes(d.nonceHex), hexToBytes(d.aadHex)).encrypt(
      utf8Encode(d.plaintextUtf8),
    );
    expect(bytesToHex(ct)).toBe(d.ciphertextAndTagHex);
  });
});

describe.each((V.handshakes as any[]).map((h: any): [string, any] => [h.name, h]))(
  'sec handshake %s',
  (_name, h: any) => {
    const sides = ['desk', 'assist'] as const;

    it('public keys, commits and message shapes', () => {
      for (const s of sides) {
        const p = h[s];
        expect(secPublicKey(hexToBytes(p.eskHex))).toBe(p.epk);
        expect(canonicalJson({ side: s, suite: h.suite, epk: p.epk, fpr: p.fpr })).toBe(p.commitPreimage);
        expect(commitHash(s, h.suite, p.epk, p.fpr)).toBe(p.h);
        expect(secCommitSchema.parse(p.commit)).toEqual(p.commit);
        expect(secHelloSchema.parse(p.hello)).toEqual(p.hello);
        expect(p.commit.gen).toBe(h.gen);
        verifyHelloAgainstCommit(p.hello, p.commit.h);
      }
    });

    it('shared secret, transcript, keys, SAS and confirm MACs', () => {
      const e = h.expected;
      const ssD = secSharedSecret(hexToBytes(h.desk.eskHex), h.assist.epk);
      const ssA = secSharedSecret(hexToBytes(h.assist.eskHex), h.desk.epk);
      expect(bytesToHex(ssD)).toBe(e.ssHex);
      expect(bytesToHex(ssA)).toBe(e.ssHex);
      const tIn = {
        sessionId: h.sessionId,
        suite: h.suite,
        gen: h.gen,
        desk: { h: h.desk.h, epk: h.desk.epk, fpr: h.desk.fpr },
        assist: { h: h.assist.h, epk: h.assist.epk, fpr: h.assist.fpr },
      };
      expect(secTranscript(tIn)).toBe(e.transcript);
      const T = secTranscriptHash(tIn);
      expect(bytesToHex(T)).toBe(e.transcriptHashHex);
      const k = deriveSecKeys(ssD, T);
      expect(bytesToHex(k.prk)).toBe(e.prkHex);
      expect(bytesToHex(k.kD2A)).toBe(e.kD2AHex);
      expect(bytesToHex(k.kA2D)).toBe(e.kA2DHex);
      expect(bytesToHex(k.kConf)).toBe(e.kConfHex);
      expect(k.sas).toBe(e.sas);
      expect(sasDisplay(k.sas)).toBe(e.sasDisplay);
      expect(secConfirmSchema.parse(e.deskConfirm)).toEqual(e.deskConfirm);
      expect(secConfirmMac(k.kConf, 'desk', T)).toBe(e.deskConfirm.mac);
      expect(secConfirmMac(k.kConf, 'assist', T)).toBe(e.assistConfirm.mac);
      verifySecConfirm(k.kConf, 'desk', T, e.deskConfirm.mac);
      verifySecConfirm(k.kConf, 'assist', T, e.assistConfirm.mac);
    });
  },
);

describe('sec frames', () => {
  it.each(
    (V.frames as any[]).map((f: any): [string, any] => [`${f.label} ${f.direction} gen ${f.gen} seq ${f.seq}`, f]),
  )('%s', (_n, f: any) => {
    const k = keysFor(f.gen);
    const direction = f.direction as SecDirection;
    const key = direction === 'desk_to_assist' ? k.kD2A : k.kA2D;
    const seq = BigInt(f.seq);
    expect(SEC_LABEL_IDS[f.label as SecEncryptedLabel]).toBe(f.labelId);
    expect(bytesToHex(secNonce(f.label, direction, f.gen, seq))).toBe(f.nonceHex);
    expect(bytesToHex(secAad(k.sessionId, f.label, f.flags))).toBe(f.aadHex);
    const plaintext: string | Uint8Array = f.plaintextUtf8 ?? hexToBytes(f.plaintextHex);
    const params = { key, sessionId: k.sessionId, label: f.label, gen: f.gen, direction };
    expect(bytesToHex(encodeSecFrame({ ...params, seq, plaintext }))).toBe(f.frameHex);
    const d = decodeSecFrame({ ...params, expectedSeq: seq, frame: hexToBytes(f.frameHex) });
    expect(d.text).toBe(f.flags === 1);
    expect(bytesToHex(d.plaintext)).toBe(bytesToHex(typeof plaintext === 'string' ? utf8Encode(plaintext) : plaintext));
  });

  it('SecChannel round-trips both ways and refuses a second start at seq 0', () => {
    const kD2A = new Uint8Array(32).fill(7);
    const kA2D = new Uint8Array(32).fill(9);
    const o = { sessionId: 's-1', label: 'ia.chat' as const, gen: 3, kD2A, kA2D };
    const desk = new SecChannel({ ...o, side: 'desk' });
    const assist = new SecChannel({ ...o, side: 'assist' });
    expect(assist.open(desk.seal('{"t":"chat.message"}')).text).toBe('{"t":"chat.message"}');
    expect(desk.open(assist.seal(new Uint8Array([1, 2, 3]))).bytes).toEqual(new Uint8Array([1, 2, 3]));
    const second = desk.seal('x');
    expect(reasonOf(() => assist.open(desk.seal('y')))).toBe('replay');
    expect(reasonOf(() => assist.open(second))).toBe('none');
    expect(() => new SecChannel({ ...o, side: 'desk' })).toThrow(/already started/);
    expect(reasonOf(() => desk.seal(new Uint8Array(131072 - 25)))).toBe('oversize');
  });
});

describe('sec negative vectors', () => {
  const h0 = V.handshakes[0];
  const T0 = hexToBytes(h0.expected.transcriptHashHex);
  it.each((V.negative as any[]).map((n: any): [string, any] => [n.name, n]))('%s', (_n, n: any) => {
    let got: SecFailReason | 'none';
    switch (n.kind) {
      case 'hello':
        got = reasonOf(() => verifyHelloAgainstCommit(secHelloSchema.parse(n.hello), n.committedH));
        break;
      case 'fingerprint':
        got = reasonOf(() => verifyPeerFingerprint(n.hello.fpr, n.observedRemoteFpr));
        break;
      case 'key':
        got = reasonOf(() => secSharedSecret(hexToBytes(n.eskHex), n.peerEpk));
        break;
      case 'mac':
        got = reasonOf(() => verifySecConfirm(hexToBytes(h0.expected.kConfHex), 'assist', T0, n.mac));
        break;
      case 'frame': {
        const k = keysFor(n.gen);
        const key = n.direction === 'desk_to_assist' ? k.kD2A : k.kA2D;
        got = reasonOf(() =>
          decodeSecFrame({
            key,
            sessionId: k.sessionId,
            label: n.label,
            gen: n.gen,
            direction: n.direction,
            expectedSeq: BigInt(n.expectedSeq),
            frame: hexToBytes(n.frameHex),
          }),
        );
        break;
      }
      default:
        throw new Error(`unknown negative kind ${n.kind}`);
    }
    expect(got).toBe(n.expect);
  });
});

describe('shared helper vectors (ported by Rust and Kotlin)', () => {
  it.each((V.fingerprintFromSdp as any[]).map((f: any): [string, any] => [f.name, f]))(
    'fingerprintFromSdp %s',
    (_n, f: any) => {
      expect(fingerprintFromSdp(f.sdp)).toBe(f.fpr);
    },
  );
  it('canonicalJson', () => {
    for (const c of V.canonicalJson) expect(canonicalJson(c.value)).toBe(c.canonical);
  });
  it('opIdFor', () => {
    for (const o of V.opIds) expect(opIdFor(o.sessionId, o.id)).toBe(o.opId);
  });
  it('sanitiseFileName', () => {
    for (const f of V.fileNames) expect(sanitiseFileName(f.name, f.fileId)).toBe(f.sanitised);
  });
  it('normaliseTokenInput', () => {
    for (const j of V.joinInput) expect(normaliseTokenInput(j.input)).toEqual(j.normalised);
  });
  it('isValidShortCode', () => {
    for (const s of V.shortCodes) expect(isValidShortCode(s.code)).toBe(s.valid);
  });
  it('base64url of a fresh epk is 43 chars', () => {
    expect(base64urlEncode(new Uint8Array(32))).toHaveLength(43);
  });
});
