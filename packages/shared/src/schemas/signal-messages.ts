/**
 * WebSocket `/signal` message schemas (contracts section 7.1-7.3). Every `t` has exactly one shape.
 * Envelope: `t` required, optional client correlation `id`, optional reply `re`, optional integer `ts` (ms).
 * Payload fields are top level.
 */
import { z } from 'zod';
import {
  brandingPublicSchema,
  consentStateSchema,
  consentSurfaceSchema,
  epochMsSchema,
  iceServerSchema,
  isoTimestampSchema,
  packageTierSchema,
  regionSchema,
  sessionEndReasonSchema,
  sessionPathSchema,
  sessionStateSchema,
  sideSchema,
  userRefSchema,
  userRoleSchema,
  uuidSchema,
} from './common.js';
import { fileEventDataSchema } from './rest-sessions.js';
import { SIGNAL_ERROR_CODES } from '../errors.js';

const envelope = {
  id: z.string().max(64).optional(),
  re: z.string().max(64).optional(),
  ts: epochMsSchema.optional(),
};

function msg<T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  return z.object({ t: z.literal(t), ...envelope, ...shape });
}

const sessionId = uuidSchema;
const optionalIce = {
  iceServers: z.array(iceServerSchema).optional(),
  iceTtl: z.number().int().positive().optional(),
  iceExpiresAt: isoTimestampSchema.optional(),
};

export const iceCandidateInitSchema = z.object({
  candidate: z.string().optional(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
  usernameFragment: z.string().nullable().optional(),
});

// ---------- client -> server (and relayed) ----------

export const assistHelloSchema = msg('assist.hello', {});
export const deskHelloSchema = msg('desk.hello', {
  token: z.string().min(1).max(4096),
  deskLabel: z.string().max(1000).optional(),
  resumeKey: z.string().min(1).max(256).optional(),
});
export const deskPollSchema = msg('desk.poll', {});
export const deskKnockSchema = msg('desk.knock', { deskLabel: z.string().max(1000).optional() });
export const assistAcceptSchema = msg('assist.accept', { sessionId });
export const assistDenySchema = msg('assist.deny', {
  sessionId,
  reason: z.string().max(5000).optional(),
  revokeToken: z.boolean().optional(),
});
export const deskConsentSchema = msg('desk.consent', {
  state: z.enum(['granted', 'revoked']),
  surface: consentSurfaceSchema.optional(),
});
export const webrtcOfferSchema = msg('webrtc.offer', { sessionId, sdp: z.string().max(60000) });
export const webrtcAnswerSchema = msg('webrtc.answer', { sessionId, sdp: z.string().max(60000) });
export const webrtcIceSchema = msg('webrtc.ice', { sessionId, candidate: iceCandidateInitSchema.nullable() });
export const chatMessageSchema = msg('chat.message', {
  sessionId,
  msgId: uuidSchema,
  from: sideSchema,
  text: z.string().max(4000),
  ts: epochMsSchema,
});
export const chatChannelOpenSchema = msg('chat.channel_open', { sessionId });
export const sessionStatsSchema = msg('session.stats', {
  sessionId,
  path: sessionPathSchema,
  rttMs: z.number().nonnegative().nullable(),
  codec: z.string().max(100).nullable(),
  bitrateKbps: z.number().nonnegative().nullable(),
  fps: z.number().nonnegative().nullable(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  packetsLost: z.number().int().nullable(),
  ts: epochMsSchema,
});
export const deskEventSchema = msg('desk.event', {
  sessionId,
  action: z.enum(['file.sent', 'file.received']),
  data: fileEventDataSchema,
});
export const assistResumeSchema = msg('assist.resume', { sessionId });
export const sessionEndSchema = msg('session.end', { sessionId, note: z.string().max(5000).optional() });
export const pingSchema = msg('ping', {});
export const pongSchema = msg('pong', {});

// ---------- server -> client ----------

export const assistHelloOkSchema = msg('assist.hello.ok', {
  connectionId: z.string(),
  user: z.object({ id: uuidSchema, name: z.string(), role: userRoleSchema }),
  region: regionSchema,
});
export const deskHelloOkSchema = msg('desk.hello.ok', {
  connectionId: z.string(),
  tokenId: uuidSchema,
  tier: packageTierSchema,
  technician: z.object({ name: z.string() }).nullable(),
  org: brandingPublicSchema,
  region: regionSchema,
  resume: z.object({ sessionId, state: sessionStateSchema, consentState: consentStateSchema }).optional(),
});
export const pollStatusSchema = msg('poll.status', {
  state: z.enum(['waiting', 'held', 'matched']),
  sessionId: sessionId.optional(),
  sessionState: sessionStateSchema.optional(),
  technicianOnline: z.boolean(),
});
export const knockOkSchema = msg('knock.ok', { sessionId, resumeKey: z.string(), expiresAt: isoTimestampSchema });
export const knockHeldSchema = msg('knock.held', { technicianOnline: z.literal(false) });
export const tokenPresenceSchema = msg('token.presence', {
  tokenId: uuidSchema,
  waiting: z.boolean(),
  held: z.boolean(),
});
export const assistKnockSchema = msg('assist.knock', {
  sessionId,
  tokenId: uuidSchema,
  tokenLabel: z.string().nullable(),
  tokenCreatedBy: userRefSchema,
  deskLabel: z.string().nullable(),
  userAgent: z.string().nullable(),
  knockedAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  canAct: z.boolean(),
});
export const knockClosedSchema = msg('knock.closed', {
  sessionId,
  by: z.enum(['accepted', 'denied', 'timeout', 'ended', 'revoked']),
  acceptedBy: userRefSchema.optional(),
});
export const sessionCreatedSchema = msg('session.created', {
  sessionId,
  tokenId: uuidSchema,
  tier: packageTierSchema,
  state: sessionStateSchema,
  consentState: consentStateSchema,
  assist: userRefSchema,
  desk: z.object({ label: z.string() }),
  org: brandingPublicSchema,
  polite: z.boolean(),
  ...optionalIce,
});
export const consentOkSchema = msg('consent.ok', {
  sessionId: sessionId.optional(),
  state: sessionStateSchema,
  consentState: consentStateSchema.optional(),
  ...optionalIce,
});
export const consentChangedSchema = msg('consent.changed', {
  sessionId,
  state: consentStateSchema,
  surface: consentSurfaceSchema.optional(),
});
export const sessionRecordingSchema = msg('session.recording', { sessionId, recording: z.boolean() });
export const iceRefreshSchema = msg('ice.refresh', {
  sessionId,
  iceServers: z.array(iceServerSchema),
  iceTtl: z.number().int().positive(),
  iceExpiresAt: isoTimestampSchema,
});
export const deskReconnectedSchema = msg('desk.reconnected', {
  sessionId,
  state: sessionStateSchema,
  consentState: consentStateSchema,
});
export const assistReconnectedSchema = msg('assist.reconnected', {
  sessionId,
  state: sessionStateSchema,
  ...optionalIce,
});
export const sessionEndedSchema = msg('session.ended', {
  sessionId,
  endReason: sessionEndReasonSchema,
  endedAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  hashChainTail: z.string().nullable(),
  assist: userRefSchema,
  surface: consentSurfaceSchema.nullable(),
  recordingStarted: z.boolean(),
  reachedActive: z.boolean(),
});
export const eventOkSchema = msg('event.ok', { sessionId, entryId: uuidSchema });
export const signalErrorSchema = msg('error', {
  code: z.enum(SIGNAL_ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
