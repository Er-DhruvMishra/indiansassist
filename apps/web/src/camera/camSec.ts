/**
 * The `ia.cam` commit-before-reveal exchange (docs/specs/phase-f-contracts.md section 6.5), as two small pure state
 * machines the phone page and the console panel drive over the negotiated data channel (`id: 0`, `negotiated: true`):
 *
 *   (1) Assist -> phone `{ t: 'commit', c: hex(sha256(nA)) }`
 *   (2) phone -> Assist `{ t: 'nonce', n: base64url(nP) }`, only after the commit arrived
 *   (3) Assist -> phone `{ t: 'reveal', n: base64url(nA) }`; the phone checks it against the commit
 *
 * Both sides then show `cameraSecurityCode(offerFpr, answerFpr, nA, nP)` as `123 456`. Any frame out of order, a
 * repeated frame or a reveal that does not match the commit is an error: the camera ends with `reason: 'error'`.
 */
import {
  base64urlDecode,
  base64urlEncode,
  CAMERA_NONCE_BYTES,
  cameraCommit,
  cameraSecFrameSchema,
  cameraSecurityCode,
  type CameraSecFrame,
} from '@indiansassist/shared';

export type SecStep = { send?: CameraSecFrame; code?: string; error?: string };

export type Fingerprints = { offer: string; answer: string };

/** The `a=fingerprint` value of an SDP (`sha-256 AB:CD:...`), the first one when several are present. */
export function sdpFingerprint(sdp: string | null | undefined): string | null {
  const m = /^a=fingerprint:([^\r\n]+)$/m.exec(sdp ?? '');
  return m ? m[1]!.trim() : null;
}

/** `123456` -> `123 456`. */
export function formatSecurityCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3, 6)}`;
}

export function parseSecFrame(data: unknown): CameraSecFrame | null {
  if (typeof data !== 'string' || data.length > 256) return null;
  try {
    const r = cameraSecFrameSchema.safeParse(JSON.parse(data));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function decodeNonce(n: string): Uint8Array | null {
  try {
    const b = base64urlDecode(n);
    return b.length === CAMERA_NONCE_BYTES ? b : null;
  } catch {
    return null;
  }
}

export type RandomBytes = (n: number) => Uint8Array;
export const cryptoRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** The console's side: commits first, reveals after the phone's nonce. */
export class CamSecAssist {
  private readonly nA: Uint8Array;
  private committed = false;
  private done = false;

  constructor(
    private readonly fingerprints: () => Fingerprints | null,
    random: RandomBytes = cryptoRandom,
  ) {
    this.nA = random(CAMERA_NONCE_BYTES);
  }

  /** Step (1): sent once the channel opens. */
  commit(): CameraSecFrame {
    this.committed = true;
    return { t: 'commit', c: cameraCommit(this.nA) };
  }

  onFrame(frame: CameraSecFrame | null): SecStep {
    if (this.done) return { error: 'unexpected camera security frame' };
    if (!frame || frame.t !== 'nonce') return { error: 'unexpected camera security frame' };
    if (!this.committed) return { error: 'the phone sent its nonce before the commit' };
    const fp = this.fingerprints();
    if (!fp) return { error: 'no DTLS fingerprints' };
    this.done = true;
    const nP = decodeNonce(frame.n);
    if (!nP) return { error: 'the phone sent a malformed nonce' };
    return {
      send: { t: 'reveal', n: base64urlEncode(this.nA) },
      code: cameraSecurityCode(fp.offer, fp.answer, this.nA, nP),
    };
  }
}

/** The phone's side: answers the commit with its nonce, checks the reveal. */
export class CamSecPhone {
  private readonly nP: Uint8Array;
  private commitHex: string | null = null;
  private done = false;

  constructor(
    private readonly fingerprints: () => Fingerprints | null,
    random: RandomBytes = cryptoRandom,
  ) {
    this.nP = random(CAMERA_NONCE_BYTES);
  }

  onFrame(frame: CameraSecFrame | null): SecStep {
    if (this.done || !frame) return { error: 'unexpected camera security frame' };
    if (frame.t === 'commit') {
      if (this.commitHex !== null) return { error: 'a second commit' };
      this.commitHex = frame.c;
      return { send: { t: 'nonce', n: base64urlEncode(this.nP) } };
    }
    if (frame.t === 'reveal') {
      if (this.commitHex === null) return { error: 'a reveal before the commit' };
      this.done = true;
      const nA = decodeNonce(frame.n);
      if (!nA || cameraCommit(nA) !== this.commitHex)
        return { error: 'the technician console revealed a value that does not match its commitment' };
      const fp = this.fingerprints();
      if (!fp) return { error: 'no DTLS fingerprints' };
      return { code: cameraSecurityCode(fp.offer, fp.answer, nA, this.nP) };
    }
    return { error: 'unexpected camera security frame' };
  }
}
