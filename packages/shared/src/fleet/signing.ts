/**
 * Phase D device signatures (docs/specs/phase-d-contracts.md conventions table and section 3.8). Every Ed25519
 * signature a device makes is over `deviceSigningInput(domain, fields)`: `utf8(domain)` then, per field in the table's
 * order, a 4-byte big-endian length and the field bytes. UUIDs are their lower-case 36-char text, base64url values are
 * decoded to raw bytes, integers are decimal ASCII, structured payloads are `canonicalJsonBytes(value)`, plain text is
 * UTF-8. Pure Ed25519 (RFC 8032), no prehash. Mirrored by `ia_core::devsig`; vectors in
 * `test/fixtures/fleet/signatures.json`.
 */
import { canonicalJsonBytes } from '../canonical.js';
import { ed } from '../crypto.js';
import { base64urlDecode, base64urlEncode, utf8Encode } from '../encoding.js';
import type { DeviceSigDomain } from '../enums.js';

/** One signed field and its encoding. */
export type DeviceSigField =
  | { uuid: string }
  | { b64u: string; bytes?: number }
  | { int: number }
  | { json: unknown }
  | { text: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fieldBytes(f: DeviceSigField): Uint8Array {
  if ('uuid' in f) {
    if (!UUID_RE.test(f.uuid)) throw new Error('device signature field: expected a lower-case uuid');
    return utf8Encode(f.uuid);
  }
  if ('b64u' in f) {
    const b = base64urlDecode(f.b64u);
    if (f.bytes !== undefined && b.length !== f.bytes) throw new Error(`device signature field: expected ${f.bytes} bytes`);
    return b;
  }
  if ('int' in f) {
    if (!Number.isSafeInteger(f.int)) throw new Error('device signature field: expected a safe integer');
    return utf8Encode(String(f.int === 0 ? 0 : f.int));
  }
  if ('json' in f) return canonicalJsonBytes(f.json);
  return utf8Encode(f.text);
}

/** The bytes a device signs for `domain` over `fields` (section 3.8 framing). */
export function deviceSigningInput(domain: DeviceSigDomain, fields: readonly DeviceSigField[]): Uint8Array {
  const parts: Uint8Array[] = [utf8Encode(domain)];
  for (const f of fields) {
    const b = fieldBytes(f);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, false);
    parts.push(len, b);
  }
  return ed.etc.concatBytes(...parts);
}

/** Per-domain builders: the field lists of the section 3.8 table, in order. */
export const deviceSigInput = {
  enroll: (p: { tokenId: string; devicePublicKey: string; deviceKexPublicKey: string }) =>
    deviceSigningInput('ia-enroll-v1', [{ uuid: p.tokenId }, { b64u: p.devicePublicKey, bytes: 32 }, { b64u: p.deviceKexPublicKey, bytes: 32 }]),
  hello: (p: { deviceId: string; serverChallenge: string; nonce: string }) =>
    deviceSigningInput('ia-dev-v1', [{ uuid: p.deviceId }, { b64u: p.serverChallenge, bytes: 32 }, { b64u: p.nonce, bytes: 16 }]),
  rotate: (p: { deviceId: string; rotationNonce: string; newPublicKey: string; newKexPublicKey: string }) =>
    deviceSigningInput('ia-rot-v1', [
      { uuid: p.deviceId },
      { b64u: p.rotationNonce, bytes: 16 },
      { b64u: p.newPublicKey, bytes: 32 },
      { b64u: p.newKexPublicKey, bytes: 32 },
    ]),
  rotateNew: (p: { deviceId: string; rotationNonce: string; oldKeyId: string }) =>
    deviceSigningInput('ia-rot-new-v1', [{ uuid: p.deviceId }, { b64u: p.rotationNonce, bytes: 16 }, { text: p.oldKeyId }]),
  deregister: (p: { deviceId: string; ts: number; nonce: string }) =>
    deviceSigningInput('ia-dereg-v1', [{ uuid: p.deviceId }, { int: p.ts }, { b64u: p.nonce, bytes: 16 }]),
  /** `event` without `sig`. */
  tamper: (p: { deviceId: string; event: Record<string, unknown> }) => {
    const { sig: _sig, ...rest } = p.event as { sig?: unknown };
    void _sig;
    return deviceSigningInput('ia-tamper-v1', [{ uuid: p.deviceId }, { json: rest }]);
  },
  /** `{ actionId, state, approvedBy?, result? }` with absent keys omitted. */
  action: (p: { deviceId: string; actionId: string; state: string; approvedBy?: string | undefined; result?: unknown }) =>
    deviceSigningInput('ia-action-v1', [
      { uuid: p.deviceId },
      {
        json: {
          actionId: p.actionId,
          state: p.state,
          ...(p.approvedBy !== undefined ? { approvedBy: p.approvedBy } : {}),
          ...(p.result !== undefined ? { result: p.result } : {}),
        },
      },
    ]),
  sas: (p: { sessionId: string; gen: number; sas: string; deskFpr: string; assistFpr: string }) =>
    deviceSigningInput('ia-sas-v1', [{ uuid: p.sessionId }, { int: p.gen }, { text: p.sas }, { text: p.deskFpr }, { text: p.assistFpr }]),
} as const;

/** Signs `input` with a 32-byte Ed25519 seed (device side; tests and the smoke's simulated device). */
export function signDeviceInput(input: Uint8Array, seed: Uint8Array): string {
  return base64urlEncode(ed.sign(input, seed));
}

/** The base64url Ed25519 public key of a 32-byte seed. */
export function devicePublicKeyOf(seed: Uint8Array): string {
  return base64urlEncode(ed.getPublicKey(seed));
}

/** Verifies a base64url signature over `input` with a base64url public key. Never throws; false on any defect. */
export function verifyDeviceSignature(input: Uint8Array, sig: string, publicKey: string): boolean {
  try {
    const s = base64urlDecode(sig);
    const pk = base64urlDecode(publicKey);
    if (s.length !== 64 || pk.length !== 32) return false;
    return ed.verify(s, input, pk);
  } catch {
    return false;
  }
}
