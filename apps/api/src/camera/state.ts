/**
 * Phase F section 6.2 (docs/specs/phase-f-contracts.md): the phone camera's presence records and link codes.
 *
 * - `ia:cam:<sha256Hex(code)>` = `{ cameraId, sessionId, orgId, region }`, TTL `LIMITS.cameraLinkTtlSec`, taken once by
 *   `camera.hello` with `Presence.consume` (single use, cluster-wide).
 * - `ia:camsess:<sessionId>` = `{ cameraId, codeHash, state }`: one camera per session, cluster-wide (`camera_busy`),
 *   written with the link, refreshed to the session's lifetime when the phone connects and deleted when it ends.
 *
 * The code itself is never logged or stored anywhere but the hashed presence key (section 6.2b).
 */
import { randomInt } from 'node:crypto';
import { CROCKFORD_ALPHABET, LIMITS, sha256Hex, type Region } from '@indiansassist/shared';
import type { Presence } from '../adapters/presence.js';

export type CameraLinkRecord = { cameraId: string; sessionId: string; orgId: string; region: Region };
export type CameraSessionRecord = { cameraId: string; codeHash: string; state: 'linked' | 'connected' };

export const cameraLinkKey = (codeHash: string) => `ia:cam:${codeHash}`;
export const cameraSessionKey = (sessionId: string) => `ia:camsess:${sessionId}`;
/** A short lock around the busy check and the two writes of a link (two clicks racing). */
export const cameraLockKey = (sessionId: string) => `ia:camlock:${sessionId}`;

/** A connected camera's `ia:camsess:` lives as long as a session can (48 h, the token session pointer's leak guard). */
export const CAMERA_SESSION_CONNECTED_TTL_SEC = 48 * 3600;

/** Section 6.2a: 12 Crockford base32 characters from a CSPRNG (60 bits). */
export function newCameraCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += CROCKFORD_ALPHABET[randomInt(32)];
  return s;
}

export function cameraCodeHash(code: string): string {
  return sha256Hex(code);
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readCameraSession(presence: Presence, sessionId: string): Promise<CameraSessionRecord | null> {
  return parse<CameraSessionRecord>(await presence.getKey(cameraSessionKey(sessionId)));
}

export async function writeCameraSession(
  presence: Presence,
  sessionId: string,
  rec: CameraSessionRecord,
  ttlSec: number,
): Promise<void> {
  await presence.setKey(cameraSessionKey(sessionId), JSON.stringify(rec), ttlSec);
}

/** Deletes `ia:camsess:<sessionId>` only while it still names this camera (a later link is left alone). */
export async function clearCameraSession(presence: Presence, sessionId: string, cameraId: string): Promise<void> {
  const cur = await readCameraSession(presence, sessionId);
  if (cur && cur.cameraId === cameraId) await presence.delKey(cameraSessionKey(sessionId));
}

/**
 * Section 6.4 (the open item of 15.10, closed): `ia:camres:<sha256Hex(resumeKey)>` = `{ sessionId }`, written by the
 * session's owner node with each resume key it issues and deleted when the key is spent or the camera ends. A phone
 * that reconnects through a node that does not own the session finds the session here and its hello is bridged to the
 * owner, which alone checks the key (single use, the resume window). Only the hash is stored; the key is never logged.
 */
export type CameraResumeRecord = { sessionId: string };
export const cameraResumeKey = (resumeKeyHash: string) => `ia:camres:${resumeKeyHash}`;

export async function writeCameraResume(presence: Presence, resumeKeyHash: string, sessionId: string): Promise<void> {
  await presence.setKey(
    cameraResumeKey(resumeKeyHash),
    JSON.stringify({ sessionId } satisfies CameraResumeRecord),
    CAMERA_SESSION_CONNECTED_TTL_SEC,
  );
}

export async function peekCameraResume(presence: Presence, resumeKeyHash: string): Promise<CameraResumeRecord | null> {
  return parse<CameraResumeRecord>(await presence.getKey(cameraResumeKey(resumeKeyHash)));
}

export async function clearCameraResume(presence: Presence, resumeKeyHash: string): Promise<void> {
  await presence.delKey(cameraResumeKey(resumeKeyHash));
}

export async function peekCameraLink(presence: Presence, codeHash: string): Promise<CameraLinkRecord | null> {
  return parse<CameraLinkRecord>(await presence.getKey(cameraLinkKey(codeHash)));
}

export async function consumeCameraLink(presence: Presence, codeHash: string): Promise<CameraLinkRecord | null> {
  return parse<CameraLinkRecord>(await presence.consume(cameraLinkKey(codeHash)));
}

export const CAMERA_LINK_TTL_SEC = LIMITS.cameraLinkTtlSec;
