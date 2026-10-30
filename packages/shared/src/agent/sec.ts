/**
 * Phase C section 1.3: the `ia.sec` handshake (commit round, X25519, HKDF-SHA256 keys, SAS, confirm MAC) and the
 * XChaCha20-Poly1305 frame format of every encrypted P3 data channel. Browser-safe (@noble only).
 * Mirrored byte for byte by `ia_core::sec` / `ia_core::secchan` (Rust) and `SecCrypto` / `SecChannel` (Kotlin);
 * `test/fixtures/agent/sec-vectors.json` is the cross-language authority all three test against.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { expand, extract } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import {
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  constantTimeEqual,
  utf8Decode,
  utf8Encode,
} from '../encoding.js';
import {
  LIMITS,
  SEC_ENCRYPTED_LABELS,
  SEC_FAIL_REASONS,
  SEC_LABEL_IDS,
  SEC_SIDES,
  SEC_SUITE,
  type SecEncryptedLabel,
  type SecFailReason,
  type SecSide,
} from '../enums.js';

export const SEC_FRAME_VERSION = 1;
export const SEC_FRAME_HEADER_BYTES = 10;
export const SEC_TAG_BYTES = 16;
/** Largest plaintext of one frame: `secFrameMaxBytes - 26`. */
export const SEC_MAX_PLAINTEXT = LIMITS.secFrameMaxBytes - SEC_FRAME_HEADER_BYTES - SEC_TAG_BYTES;
const FLAG_TEXT = 0b0000_0001;

export type SecDirection = 'desk_to_assist' | 'assist_to_desk';

/** A handshake or frame failure carrying the `sec.fail.reason` the caller sends (section 1.3 step 9). */
export class SecError extends Error {
  constructor(
    readonly reason: SecFailReason,
    message?: string,
  ) {
    super(message ?? `sec.fail: ${reason}`);
    this.name = 'SecError';
  }
}

// ---------- wire schemas (`ia.sec` carries these and nothing else) ----------

const b64u32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const fpr64 = z.string().regex(/^[0-9a-f]{64}$/);
const sessionIdSchema = z.string().min(1).max(64);
const tsSchema = z.number().int().nonnegative();

export const secCommitSchema = z.strictObject({
  t: z.literal('sec.commit'),
  v: z.literal(1),
  sessionId: sessionIdSchema,
  side: z.enum(SEC_SIDES),
  h: b64u32,
  gen: z.number().int().min(0).max(65535),
  ts: tsSchema,
});
export const secHelloSchema = z.strictObject({
  t: z.literal('sec.hello'),
  v: z.literal(1),
  sessionId: sessionIdSchema,
  side: z.enum(SEC_SIDES),
  // Any string: an unknown suite must parse so it can be answered with `sec.fail { reason: 'suite' }`.
  suite: z.string().min(1).max(64),
  epk: b64u32,
  fpr: fpr64,
  ts: tsSchema,
});
export const secConfirmSchema = z.strictObject({ t: z.literal('sec.confirm'), mac: b64u32, ts: tsSchema });
export const secFailSchema = z.strictObject({
  t: z.literal('sec.fail'),
  reason: z.enum(SEC_FAIL_REASONS),
  ts: tsSchema,
});
export const secMessageSchema = z.discriminatedUnion('t', [
  secCommitSchema,
  secHelloSchema,
  secConfirmSchema,
  secFailSchema,
]);
export type SecCommit = z.infer<typeof secCommitSchema>;
export type SecHello = z.infer<typeof secHelloSchema>;
export type SecConfirm = z.infer<typeof secConfirmSchema>;
export type SecFail = z.infer<typeof secFailSchema>;
export type SecMessage = z.infer<typeof secMessageSchema>;

// ---------- handshake ----------

/** `base64url(sha256(utf8(canonicalJson({ side, suite, epk, fpr }))))` (step 2a). */
export function commitHash(side: SecSide, suite: string, epk: string, fpr: string): string {
  return base64urlEncode(sha256(utf8Encode(canonicalJson({ side, suite, epk, fpr }))));
}

/**
 * Step 2b then 3a: an unknown suite is `SecError('suite')` (checked on receipt, before the commit), then the revealed
 * hello must hash to the sender's commit, constant time, else `SecError('commit')`.
 */
export function verifyHelloAgainstCommit(hello: SecHello, committedH: string): void {
  if (hello.suite !== SEC_SUITE) throw new SecError('suite');
  if (!constantTimeEqual(commitHash(hello.side, hello.suite, hello.epk, hello.fpr), committedH)) {
    throw new SecError('commit');
  }
}

/** Step 3b: `peer.fpr === observedRemoteFingerprint`, constant time. */
export function verifyPeerFingerprint(peerFpr: string, observedRemoteFpr: string): void {
  if (!constantTimeEqual(peerFpr, observedRemoteFpr)) throw new SecError('fingerprint');
}

/** X25519 public key (base64url) of a raw 32-byte private key. */
export function secPublicKey(esk: Uint8Array): string {
  return base64urlEncode(x25519.getPublicKey(esk));
}

/** A fresh ephemeral key pair (step 1). */
export function secGenerateKeyPair(): { esk: Uint8Array; epk: string } {
  const esk = x25519.utils.randomPrivateKey();
  return { esk, epk: secPublicKey(esk) };
}

/** Step 4: `ss = X25519(esk, peer.epk)`; an all-zero result (low-order point) is `SecError('key')`. */
export function secSharedSecret(esk: Uint8Array, peerEpk: string): Uint8Array {
  let ss: Uint8Array;
  try {
    const pub = base64urlDecode(peerEpk);
    if (pub.length !== 32) throw new Error('epk length');
    ss = x25519.getSharedSecret(esk, pub);
  } catch {
    throw new SecError('key');
  }
  if (ss.every((b) => b === 0)) throw new SecError('key');
  return ss;
}

export interface SecSideInfo {
  h: string;
  epk: string;
  fpr: string;
}

export interface SecTranscriptInput {
  sessionId: string;
  suite: string;
  gen: number;
  desk: SecSideInfo;
  assist: SecSideInfo;
}

/** The canonical transcript string whose sha256 is `T` (step 4). */
export function secTranscript(t: SecTranscriptInput): string {
  const side = (s: SecSideInfo) => ({ h: s.h, epk: s.epk, fpr: s.fpr });
  return canonicalJson({
    v: 1,
    sessionId: t.sessionId,
    suite: t.suite,
    gen: t.gen,
    desk: side(t.desk),
    assist: side(t.assist),
  });
}

/** `T = sha256(utf8(transcript))`. */
export function secTranscriptHash(t: SecTranscriptInput): Uint8Array {
  return sha256(utf8Encode(secTranscript(t)));
}

export interface SecKeys {
  prk: Uint8Array;
  kD2A: Uint8Array;
  kA2D: Uint8Array;
  kConf: Uint8Array;
  /** Six digits, zero-padded. */
  sas: string;
}

/** Step 5: HKDF-SHA256 with salt `T` over `ss`. */
export function deriveSecKeys(ss: Uint8Array, transcriptHash: Uint8Array): SecKeys {
  const prk = extract(sha256, ss, transcriptHash);
  const info = (s: string) => utf8Encode(`ia-sec-v1 ${s}`);
  const raw = expand(sha256, prk, info('sas'), 4);
  const n = ((raw[0]! << 24) >>> 0) + (raw[1]! << 16) + (raw[2]! << 8) + raw[3]!;
  return {
    prk,
    kD2A: expand(sha256, prk, info('desk->assist'), 32),
    kA2D: expand(sha256, prk, info('assist->desk'), 32),
    kConf: expand(sha256, prk, info('confirm'), 32),
    sas: String(n % 1_000_000).padStart(6, '0'),
  };
}

/** `483920` -> `483 920` (step 7). */
export function sasDisplay(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

/** Step 6: `base64url(HMAC-SHA256(kConf, utf8(side) || T))` where `side` is the sender's own side. */
export function secConfirmMac(kConf: Uint8Array, side: SecSide, transcriptHash: Uint8Array): string {
  const side8 = utf8Encode(side);
  const msg = new Uint8Array(side8.length + transcriptHash.length);
  msg.set(side8, 0);
  msg.set(transcriptHash, side8.length);
  return base64urlEncode(hmac(sha256, kConf, msg));
}

/** Verifies the peer's confirm MAC, constant time; `SecError('mac')` otherwise. */
export function verifySecConfirm(kConf: Uint8Array, peerSide: SecSide, transcriptHash: Uint8Array, mac: string): void {
  if (!constantTimeEqual(secConfirmMac(kConf, peerSide, transcriptHash), mac)) throw new SecError('mac');
}

/**
 * Step 1: the first `a=fingerprint:sha-256` line (session level, else the first media level, which is simply the
 * first such line in document order) normalised to 64 lower-case hex chars without colons; `null` when absent.
 */
export function fingerprintFromSdp(sdp: string): string | null {
  for (const rawLine of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/i.exec(rawLine.trim());
    if (!m) continue;
    const hex = m[1]!.replace(/:/g, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  }
  return null;
}

// ---------- frames ----------

export function isSecEncryptedLabel(label: string): label is SecEncryptedLabel {
  return (SEC_ENCRYPTED_LABELS as readonly string[]).includes(label);
}

function labelIdOf(label: string): number {
  if (!isSecEncryptedLabel(label)) throw new Error(`${label} is not an encrypted channel`);
  return SEC_LABEL_IDS[label];
}

function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
}

/** Nonce = labelId || direction || u16be(gen) || 12 zero bytes || u64be(seq). */
export function secNonce(label: string, direction: SecDirection, gen: number, seq: bigint): Uint8Array {
  const n = new Uint8Array(24);
  n[0] = labelIdOf(label);
  n[1] = direction === 'desk_to_assist' ? 0 : 1;
  n[2] = (gen >> 8) & 0xff;
  n[3] = gen & 0xff;
  n.set(u64be(seq), 16);
  return n;
}

/** AAD = "ia-sec-v1" || sessionId || 0x00 || label || 0x00 || version || flags. */
export function secAad(sessionId: string, label: string, flags: number): Uint8Array {
  const head = utf8Encode(`ia-sec-v1${sessionId}\u0000${label}\u0000`);
  const out = new Uint8Array(head.length + 2);
  out.set(head, 0);
  out[head.length] = SEC_FRAME_VERSION;
  out[head.length + 1] = flags;
  return out;
}

export interface SecFrameParams {
  key: Uint8Array;
  sessionId: string;
  label: string;
  gen: number;
  direction: SecDirection;
}

/** Seals one frame (text when `plaintext` is a string). Throws `SecError('oversize')` above the limit. */
export function encodeSecFrame(p: SecFrameParams & { seq: bigint; plaintext: string | Uint8Array }): Uint8Array {
  const text = typeof p.plaintext === 'string';
  const body = typeof p.plaintext === 'string' ? utf8Encode(p.plaintext) : p.plaintext;
  if (body.length > SEC_MAX_PLAINTEXT) throw new SecError('oversize');
  const flags = text ? FLAG_TEXT : 0;
  const ct = xchacha20poly1305(
    p.key,
    secNonce(p.label, p.direction, p.gen, p.seq),
    secAad(p.sessionId, p.label, flags),
  ).encrypt(body);
  const frame = new Uint8Array(SEC_FRAME_HEADER_BYTES + ct.length);
  frame[0] = SEC_FRAME_VERSION;
  frame[1] = flags;
  frame.set(u64be(p.seq), 2);
  frame.set(ct, SEC_FRAME_HEADER_BYTES);
  return frame;
}

export interface DecodedSecFrame {
  seq: bigint;
  text: boolean;
  plaintext: Uint8Array;
}

/** Opens one frame enforcing `seq === expectedSeq` (`replay`), the size limit (`oversize`) and the tag (`decrypt`). */
export function decodeSecFrame(p: SecFrameParams & { expectedSeq: bigint; frame: Uint8Array }): DecodedSecFrame {
  const f = p.frame;
  if (f.length < SEC_FRAME_HEADER_BYTES + SEC_TAG_BYTES || f[0] !== SEC_FRAME_VERSION) throw new SecError('decrypt');
  const flags = f[1]!;
  if ((flags & ~FLAG_TEXT) !== 0) throw new SecError('decrypt');
  const seq = new DataView(f.buffer, f.byteOffset + 2, 8).getBigUint64(0, false);
  if (seq !== p.expectedSeq) throw new SecError('replay');
  if (f.length - SEC_FRAME_HEADER_BYTES - SEC_TAG_BYTES > SEC_MAX_PLAINTEXT) throw new SecError('oversize');
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(
      p.key,
      secNonce(p.label, p.direction, p.gen, seq),
      secAad(p.sessionId, p.label, flags),
    ).decrypt(f.subarray(SEC_FRAME_HEADER_BYTES));
  } catch {
    throw new SecError('decrypt');
  }
  return { seq, text: (flags & FLAG_TEXT) !== 0, plaintext };
}

// ---------- SecChannel ----------

/** Send streams already started, keyed by `sha256(sendKey) | labelId | direction | gen` (nonce-reuse guard). */
const startedStreams = new Set<string>();

export interface SecChannelOptions {
  side: SecSide;
  sessionId: string;
  label: SecEncryptedLabel;
  gen: number;
  kD2A: Uint8Array;
  kA2D: Uint8Array;
}

/**
 * One encrypted channel of one key generation: `seal` numbers outgoing frames from 0, `open` enforces the
 * `lastSeq + 1` rule. Constructing a second SecChannel for the same send key, label and gen throws (a second start
 * at `seq 0` would reuse an XChaCha20-Poly1305 nonce).
 */
export class SecChannel {
  private sendSeq = 0n;
  private recvSeq = 0n;
  private readonly send: SecFrameParams;
  private readonly recv: SecFrameParams;

  constructor(o: SecChannelOptions) {
    const out: SecDirection = o.side === 'desk' ? 'desk_to_assist' : 'assist_to_desk';
    const inn: SecDirection = o.side === 'desk' ? 'assist_to_desk' : 'desk_to_assist';
    const sendKey = o.side === 'desk' ? o.kD2A : o.kA2D;
    const id = `${bytesToHex(sha256(sendKey))}|${SEC_LABEL_IDS[o.label]}|${out}|${o.gen}`;
    if (startedStreams.has(id)) throw new Error(`SecChannel ${o.label} gen ${o.gen} already started at seq 0`);
    startedStreams.add(id);
    this.send = { key: sendKey, sessionId: o.sessionId, label: o.label, gen: o.gen, direction: out };
    this.recv = {
      key: o.side === 'desk' ? o.kA2D : o.kD2A,
      sessionId: o.sessionId,
      label: o.label,
      gen: o.gen,
      direction: inn,
    };
  }

  seal(plaintext: string | Uint8Array): Uint8Array {
    const frame = encodeSecFrame({ ...this.send, seq: this.sendSeq, plaintext });
    this.sendSeq += 1n;
    return frame;
  }

  open(frame: Uint8Array): { text: string | null; bytes: Uint8Array } {
    const d = decodeSecFrame({ ...this.recv, expectedSeq: this.recvSeq, frame });
    this.recvSeq += 1n;
    return { text: d.text ? utf8Decode(d.plaintext) : null, bytes: d.plaintext };
  }
}
