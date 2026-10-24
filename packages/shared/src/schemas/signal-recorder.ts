/**
 * Phase A.2 server-side recorder (docs/specs/phase-a2-recorder.md sections 3, 5, 9, 10): the recorder's `/signal`
 * messages, the org recording policy body and the internal upload `meta` field. Envelope as Phase A section 7.1.
 */
import { z } from 'zod';
import { LIMITS, RECORDER_ID_RE, RECORDER_STOP_REASONS, RECORDING_MODES } from '../enums.js';
import {
  epochMsSchema,
  hex64Schema,
  isoTimestampSchema,
  packageTierSchema,
  regionSchema,
  uuidSchema,
} from './common.js';

const envelope = {
  id: z.string().max(64).optional(),
  re: z.string().max(64).optional(),
  ts: epochMsSchema.optional(),
};

function msg<T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  return z.object({ t: z.literal(t), ...envelope, ...shape });
}

export const recorderIdSchema = z.string().regex(RECORDER_ID_RE, 'recorderId must match ^[a-z0-9][a-z0-9._-]{0,63}$');
export const recordingModeSchema = z.enum(RECORDING_MODES);
export const recorderStopReasonSchema = z.enum(RECORDER_STOP_REASONS);
/** The modes under which the server recorder is assigned. */
export const serverRecordingModeSchema = z.enum(['server', 'both']);

// ---------- recorder -> server ----------

export const recorderHelloSchema = msg('recorder.hello', {
  token: z.string().min(1).max(256),
  recorderId: recorderIdSchema,
  version: z.string().min(1).max(32),
  region: regionSchema,
  maxSessions: z.number().int().min(1).max(LIMITS.recorderMaxSessionsMax).optional(),
});
export const recorderJoinSchema = msg('recorder.join', { sessionId: uuidSchema });
export const recorderLeaveSchema = msg('recorder.leave', { sessionId: uuidSchema, reason: recorderStopReasonSchema });

// ---------- server -> recorder ----------

export const recorderHelloOkSchema = msg('recorder.hello.ok', {
  connectionId: z.string(),
  nodeId: z.string(),
  regions: z.array(regionSchema),
});
export const recorderAssignSchema = msg('recorder.assign', {
  sessionId: uuidSchema,
  orgId: uuidSchema,
  region: regionSchema,
  tier: packageTierSchema,
  recordingMode: serverRecordingModeSchema,
  resume: z.boolean(),
  deadlineAt: isoTimestampSchema,
});
export const recorderJoinedSchema = msg('recorder.joined', { sessionId: uuidSchema, resume: z.boolean() });
export const recorderPauseSchema = msg('recorder.pause', {
  sessionId: uuidSchema,
  reason: z.literal('consent_pending'),
});

/** Message types a recorder socket may send (section 4 H4). */
export const RECORDER_CLIENT_TYPES = [
  'recorder.hello',
  'recorder.join',
  'recorder.leave',
  'webrtc.offer',
  'webrtc.answer',
  'webrtc.ice',
  'ping',
  'pong',
] as const;

// ---------- REST ----------

/** GET / PATCH `/api/v1/orgs/current/policy/recording` (section 3 M3). */
export const recordingPolicySchema = z.strictObject({ recordingMode: recordingModeSchema });

/** Multipart field `meta` of `POST /api/v1/internal/recordings` (section 9), parsed from its JSON string. */
export const internalRecordingMetaSchema = z.strictObject({
  sessionId: uuidSchema,
  recorderId: recorderIdSchema,
  mime: z
    .string()
    .max(255)
    .regex(
      /^(video\/webm|audio\/webm)(;\s*codecs=("[A-Za-z0-9,.+\-\s]+"|[A-Za-z0-9,.+\-\s]+))?$/,
      'server recordings are WebM',
    ),
  durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().positive().max(LIMITS.recordingMaxBytes),
  sha256: hex64Schema,
});

/** `GET /api/v1/ice?recorderId=` with the service token (section 10). */
export const recorderIceQuerySchema = z.object({ recorderId: recorderIdSchema });
