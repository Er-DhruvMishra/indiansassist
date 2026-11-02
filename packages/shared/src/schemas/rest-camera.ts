/**
 * Phase F section 6 (docs/specs/phase-f-contracts.md): the phone camera's REST shapes, the link code helpers and the
 * `ia.cam` commit-before-reveal security code (section 6.5). The helpers are pure and fully specified by the
 * contract, and no stream owns this file after the foundation, so the foundation lands them whole (section 16.3,
 * foundation notes); the camera stream owns the api and web code that uses them.
 */
import { z } from 'zod';
import { LIMITS } from '../enums.js';
import { sha256Bytes, sha256Hex } from '../canonical.js';
import { utf8Encode } from '../encoding.js';
import { hex64Schema, isoTimestampSchema, uuidSchema } from './common.js';

/** Crockford base32 (no I, L, O, U). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A normalised camera code: 12 Crockford characters, upper case, no separators (60 bits, section 6.2a). */
export const CAMERA_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/**
 * Section 6.2a: normalises what a person typed or a link carried: separators (`-`, spaces) removed, upper-cased,
 * `I` and `L` read as `1` and `O` as `0` (Crockford's decoding rule; `U` is not a Crockford symbol and is refused).
 * Null unless the result is exactly 12 Crockford characters.
 */
export function normaliseCameraCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const s = input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CAMERA_CODE_RE.test(s) ? s : null;
}

/** Section 6.2a display form `XXXX-XXXX-XXXX` of a normalised code (throws on anything else). */
export function formatCameraCode(code: string): string {
  if (!CAMERA_CODE_RE.test(code)) throw new Error('formatCameraCode: not a normalised camera code');
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

/** `POST /api/v1/sessions/:id/camera-links` reply (section 6.7). `code` is the normalised 12 characters. */
export const cameraLinkReplySchema = z.strictObject({
  cameraId: uuidSchema,
  url: z.string().max(2048),
  code: z.string().regex(CAMERA_CODE_RE),
  expiresAt: isoTimestampSchema,
});
export type CameraLinkReply = z.infer<typeof cameraLinkReplySchema>;

/** `POST /api/v1/sessions/:id/camera/:cameraId/snapshots` body (section 6.7). */
export const cameraSnapshotRequestSchema = z.strictObject({
  sha256: hex64Schema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
});
export type CameraSnapshotRequest = z.infer<typeof cameraSnapshotRequestSchema>;

// ---------- ia.cam (section 6.5) ----------

/** The negotiated data channel of the camera peer connection (`id: 0`, `negotiated: true`). */
export const CAMERA_SEC_CHANNEL = { label: 'ia.cam', id: 0 } as const;
/** The domain prefix of the camera security code input. */
export const CAMERA_SEC_DOMAIN = 'ia-cam-v1' as const;
/** Bytes of each side's nonce (`nA`, `nP`). */
export const CAMERA_NONCE_BYTES = 32;
/** The camera's maximum sender bitrate (section 6.5), for `camera.hello.ok.limits`. */
export const CAMERA_MAX_BITRATE_KBPS = LIMITS.cameraMaxBitrateKbps;

const b64u32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url of 32 bytes');
/** The three `ia.cam` frames, in protocol order: the Assist's commit, the phone's nonce, the Assist's reveal. */
export const cameraSecFrameSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('commit'), c: hex64Schema }),
  z.strictObject({ t: z.literal('nonce'), n: b64u32 }),
  z.strictObject({ t: z.literal('reveal'), n: b64u32 }),
]);
export type CameraSecFrame = z.infer<typeof cameraSecFrameSchema>;

function nonce32(n: Uint8Array, name: string): Uint8Array {
  if (!(n instanceof Uint8Array) || n.length !== CAMERA_NONCE_BYTES) throw new Error(`${name} must be ${CAMERA_NONCE_BYTES} bytes`);
  return n;
}

/** Step (1) of section 6.5: `hex(sha256(nA))`, the Assist's commitment, sent before the phone's nonce. */
export function cameraCommit(nA: Uint8Array): string {
  return sha256Hex(nonce32(nA, 'nA'));
}

/**
 * Section 6.5: `h = sha256(utf8("ia-cam-v1\n" + offerFpr + "\n" + answerFpr) || nA || nP)` and the six-digit code
 * `String(u32be(h[0..4]) % 1_000_000).padStart(6, '0')`, the reduction `agent/sec.ts` uses for the C SAS. Each
 * fingerprint is the `a=fingerprint` value of the DTLS certificate that side actually negotiated.
 */
export function cameraSecurityCode(offerFpr: string, answerFpr: string, nA: Uint8Array, nP: Uint8Array): string {
  const head = utf8Encode(`${CAMERA_SEC_DOMAIN}\n${offerFpr}\n${answerFpr}`);
  const a = nonce32(nA, 'nA');
  const p = nonce32(nP, 'nP');
  const input = new Uint8Array(head.length + a.length + p.length);
  input.set(head, 0);
  input.set(a, head.length);
  input.set(p, head.length + a.length);
  const h = sha256Bytes(input);
  const u32 = new DataView(h.buffer, h.byteOffset, 4).getUint32(0, false);
  return String(u32 % 1_000_000).padStart(6, '0');
}
