/**
 * Phase F section 6.4 (docs/specs/phase-f-contracts.md): the phone camera's `/signal` messages. A new hub side
 * `camera` beside `assist`, `desk` and `recorder`; `camera.hello` needs no principal. Envelope as Phase A section 7.1.
 * The `webrtc.*` frames are the existing messages with `peer: 'camera'` (`WEBRTC_PEERS`).
 */
import { z } from 'zod';
import { CAMERA_FACINGS, CAMERA_STATES, CAMERA_STOP_REASONS } from '../enums.js';
import { epochMsSchema, iceServerSchema, uuidSchema } from './common.js';

const envelope = { id: z.string().max(64).optional(), re: z.string().max(64).optional(), ts: epochMsSchema.optional() };
function msg<T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  return z.object({ t: z.literal(t), ...envelope, ...shape });
}

/** `camera.hello.ok.resumeKey`: 32 CSPRNG bytes, base64url (43 characters). */
export const cameraResumeKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'base64url of 32 bytes');
export const cameraStopReasonSchema = z.enum(CAMERA_STOP_REASONS);
/** What records the session, and therefore the camera, right now (section 6.5a). */
export const cameraRecordingSchema = z.strictObject({ server: z.boolean(), console: z.boolean() });
export type CameraRecording = z.infer<typeof cameraRecordingSchema>;

// ---------- phone -> server ----------

/** `{ code }` (the link or typed code; the server normalises it) or `{ resumeKey }` (within 60 s of a drop). */
export const cameraHelloSchema = msg('camera.hello', {
  code: z.string().min(1).max(32).optional(),
  resumeKey: cameraResumeKeySchema.optional(),
}).refine((m) => (m.code === undefined) !== (m.resumeKey === undefined), { message: 'exactly one of code and resumeKey' });
export const cameraReadySchema = msg('camera.ready', {
  cameraId: uuidSchema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  facing: z.enum(CAMERA_FACINGS),
});
export const cameraStopSchema = msg('camera.stop', { cameraId: uuidSchema, reason: cameraStopReasonSchema });

// ---------- server -> phone, Assist, P1 Desk ----------

export const cameraHelloOkSchema = msg('camera.hello.ok', {
  cameraId: uuidSchema,
  sessionId: uuidSchema,
  org: z.strictObject({ displayName: z.string().max(200) }),
  technician: z.strictObject({ name: z.string().max(200) }),
  /** TURN credentials for the principal `camera:<cameraId>`. */
  iceServers: z.array(iceServerSchema),
  resumeKey: cameraResumeKeySchema,
  limits: z.strictObject({ maxBitrateKbps: z.number().int().positive() }),
  recording: cameraRecordingSchema,
});
/** To the session's Assist, a P1 Desk, and the phone (with `recording` after a change, section 6.5a). */
export const cameraStateSchema = msg('camera.state', {
  cameraId: uuidSchema,
  state: z.enum(CAMERA_STATES),
  reason: cameraStopReasonSchema.optional(),
  recording: cameraRecordingSchema.optional(),
});
/** Then close `1000`. */
export const cameraClosedSchema = msg('camera.closed', { reason: cameraStopReasonSchema });

/** Message types a camera socket may send (section 6.4). */
export const CAMERA_CLIENT_TYPES = [
  'camera.hello',
  'camera.ready',
  'camera.stop',
  'webrtc.offer',
  'webrtc.answer',
  'webrtc.ice',
  'ping',
  'pong',
] as const;
export type CameraClientType = (typeof CAMERA_CLIENT_TYPES)[number];
