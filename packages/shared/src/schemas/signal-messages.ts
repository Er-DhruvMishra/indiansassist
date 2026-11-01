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
import {
  AGENT_CONSENT_LEVELS,
  CAPTURE_PATHS,
  CONSENT_LEVELS,
  DESK_BROWSERS,
  DESK_CLIENT_KINDS,
  DESK_OSES,
  LIMITS,
  MIRROR_SCOPES,
  MIRROR_TRANSPORTS,
  NATIVE_ARCHES,
  RECORDING_MODES,
  RECORDING_SOURCES,
  STORED_CONSENT_LEVELS,
  TOKEN_SOURCES,
  VIDEO_ENCODERS,
  WEBRTC_PEERS,
} from '../enums.js';
import { agentCapabilitiesSchema } from '../agent/capabilities.js';
import { sessionAgentSchema } from '../agent/playbook.js';
import { DESK_EVENT_P3_ACTIONS, DESK_EVENT_P3_DATA, DESK_EVENT_P3_REASON_ACTIONS } from '../audit/actions-p3.js';
import { extensionPolicySchema } from '../extension/policy.js';
import { controlMessageSchema } from '../extension/control.js';
import { DESK_EVENT_DATA, DESK_EVENT_P2_ACTIONS, DESK_EVENT_REASON_ACTIONS, opIdSchema } from '../audit/actions-p2.js';
import { DESK_EVENT_P4_ACTIONS, DESK_EVENT_P4_DATA } from '../audit/actions-p4.js';
import { APPROVED_BY } from '../enums.js';

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

const consentLevel = z.enum(CONSENT_LEVELS);
const mirrorScope = z.enum(MIRROR_SCOPES);
const clientString = z.string().min(1).max(LIMITS.deskClientStringMax);

/** Both consent-level families (Phase C section 3.4): the wire carries the one of the session's tier. */
const anyConsentLevel = z.enum(STORED_CONSENT_LEVELS);
const agentLevel = z.enum(AGENT_CONSENT_LEVELS);
const monitorIdSchema = z.number().int().min(1).max(LIMITS.monitorsMax);
const monitorIdsSchema = z
  .array(monitorIdSchema)
  .min(1)
  .max(LIMITS.monitorsMax)
  .refine((a) => new Set(a).size === a.length, 'monitor ids must be unique');

/**
 * `desk.hello.client` (Phase B section 2.4, Phase C section 3.1); absent means `{ kind: 'web' }`. Extensions send
 * version and browser; a native Desk (agent / Android host) sends version, os, platform, tokenSource and
 * capabilities and no browser. `os: 'android'` is native-only.
 */
export const deskClientSchema = z
  .strictObject({
    kind: z.enum(DESK_CLIENT_KINDS),
    version: clientString.optional(),
    browser: z
      .strictObject({ name: z.enum(DESK_BROWSERS), version: z.string().min(1).max(LIMITS.browserVersionMax) })
      .optional(),
    os: z.enum(DESK_OSES).optional(),
    platform: z.strictObject({ osVersion: z.string().min(1).max(32), arch: z.enum(NATIVE_ARCHES) }).optional(),
    tokenSource: z.enum(TOKEN_SOURCES).optional(),
    capabilities: agentCapabilitiesSchema.optional(),
  })
  .refine((c) => c.kind !== 'extension' || (c.version !== undefined && c.browser !== undefined), {
    message: 'an extension client sends version and browser',
  })
  .refine(
    (c) =>
      c.kind !== 'native' ||
      (c.version !== undefined &&
        c.platform !== undefined &&
        c.tokenSource !== undefined &&
        c.capabilities !== undefined &&
        c.browser === undefined &&
        (c.os === 'windows' || c.os === 'android')),
    { message: 'a native client sends version, os (windows | android), platform, tokenSource and capabilities, no browser' },
  )
  .refine(
    (c) =>
      c.kind === 'native' ||
      (c.platform === undefined && c.tokenSource === undefined && c.capabilities === undefined && c.os !== 'android'),
    { message: 'platform, tokenSource, capabilities and os android are native-only' },
  );

/** `desk.consent.native` (Phase C section 3.4): the native Desk's decision. */
export const nativeConsentSchema = z.strictObject({ level: agentLevel, monitors: monitorIdsSchema, clipboard: z.boolean() });

/** `{ level, scope, backstage }`: the P2 consent decision (Phase B section 3.1). */
export const extensionConsentSchema = z.strictObject({ level: consentLevel, scope: mirrorScope, backstage: z.boolean() });

// ---------- client -> server (and relayed) ----------

export const assistHelloSchema = msg('assist.hello', {});
/**
 * `desk.hello`. Phase D section 4.2: the P4 desktop worker presents a single-use `workerCredential` (43 base64url
 * characters) and no `token`; exactly one of the two is required, and `handover` is allowed only beside `token` (a
 * client that sends `token` validates exactly as before).
 */
export const deskHelloSchema = msg('desk.hello', {
  token: z.string().min(1).max(4096).optional(),
  workerCredential: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, 'a worker credential is 43 base64url characters')
    .optional(),
  deskLabel: z.string().max(1000).optional(),
  resumeKey: z.string().min(1).max(256).optional(),
  /** Phase C section 7.2: the one-time hand-over value of the elevated instance. */
  handover: z.string().min(1).max(256).optional(),
  client: deskClientSchema.optional(),
}).superRefine((m, ctx) => {
  if ((m.token === undefined) === (m.workerCredential === undefined))
    ctx.addIssue({ code: 'custom', path: ['token'], message: 'send exactly one of token and workerCredential' });
  if (m.handover !== undefined && m.token === undefined)
    ctx.addIssue({ code: 'custom', path: ['handover'], message: 'handover is only valid beside token' });
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
  extension: extensionConsentSchema.optional(),
  native: nativeConsentSchema.optional(),
  /**
   * Phase D section 6.2 (amendment): who allowed an unattended P4 session the worker showed the approval card for
   * (`local_user`, or `auto_after_timeout` when the countdown allowed it). Ignored outside P4.
   */
  approvedBy: z.enum(APPROVED_BY).optional(),
});
/** Phase A.2 N2: the Desk-side far end of a relayed frame; absent = `assist`. The server sets / strips it. */
const peer = { peer: z.enum(WEBRTC_PEERS).optional() };
/** `restart: true` = offer from a brand-new RTCPeerConnection; the receiver rebuilds its own first (Y23). */
export const webrtcOfferSchema = msg('webrtc.offer', {
  sessionId,
  sdp: z.string().max(60000),
  restart: z.boolean().optional(),
  /** Phase C section 1.3 / 3.7: the key generation of the new peer connection (P3 rebuilds). */
  gen: z.number().int().nonnegative().max(65535).optional(),
  ...peer,
});
export const webrtcAnswerSchema = msg('webrtc.answer', { sessionId, sdp: z.string().max(60000), ...peer });
export const webrtcIceSchema = msg('webrtc.ice', { sessionId, candidate: iceCandidateInitSchema.nullable(), ...peer });
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
  mirrorKbps: z.number().nonnegative().optional(),
  mirrorTabs: z.number().int().nonnegative().optional(),
  mirrorTransport: z.enum(MIRROR_TRANSPORTS).optional(),
  sessionKbps: z.number().nonnegative().optional(),
  // Phase C section 4.4: the agent stats folded in by the console (P3 only).
  encoder: z.enum(VIDEO_ENCODERS).optional(),
  hwEncoder: z.boolean().optional(),
  floorMode: z.boolean().optional(),
  targetKbps: z.number().nonnegative().optional(),
  captureFps: z.number().nonnegative().optional(),
  capturePath: z.enum(CAPTURE_PATHS).optional(),
  monitorsStreaming: z.number().int().nonnegative().max(LIMITS.monitorsMax).optional(),
  encodeMs: z.number().nonnegative().nullable().optional(),
  glassMs: z.number().nonnegative().nullable().optional(),
});

export const DESK_EVENT_ACTIONS = [
  'file.sent',
  'file.received',
  ...DESK_EVENT_P2_ACTIONS,
  ...DESK_EVENT_P3_ACTIONS,
  // Phase D section 13.3: the P4 desktop worker's attestations (P4 sessions only).
  ...DESK_EVENT_P4_ACTIONS,
] as const;
export type DeskEventAction = (typeof DESK_EVENT_ACTIONS)[number];

/**
 * `desk.event` (Phase A 7.3 + Phase B 3.6): `data` is validated per action (`fileEventDataSchema` for `file.*`,
 * `deskEventDataSchema(action)` otherwise); `reason` only for `mask.override`, `mask.refused`,
 * `consent.level_refused`.
 */
export const deskEventSchema = msg('desk.event', {
  sessionId,
  action: z.enum(DESK_EVENT_ACTIONS),
  data: z.record(z.string(), z.unknown()),
  reason: z.string().max(LIMITS.reasonMax).optional(),
}).superRefine((m, ctx) => {
  const schema: z.ZodType =
    m.action === 'file.sent' || m.action === 'file.received'
      ? fileEventDataSchema
      : m.action === 'control.input'
        ? z.union([DESK_EVENT_DATA['control.input'], DESK_EVENT_P3_DATA['control.input']])
        : ((DESK_EVENT_DATA as Record<string, z.ZodType>)[m.action] ??
          (DESK_EVENT_P3_DATA as Record<string, z.ZodType>)[m.action] ??
          (DESK_EVENT_P4_DATA as Record<string, z.ZodType>)[m.action]!);
  const r = schema.safeParse(m.data);
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', path: ['data', ...i.path], message: i.message });
  const reasonOk = [...DESK_EVENT_REASON_ACTIONS, ...DESK_EVENT_P3_REASON_ACTIONS] as readonly string[];
  if (m.reason !== undefined && !reasonOk.includes(m.action))
    ctx.addIssue({ code: 'custom', path: ['reason'], message: `reason is not accepted for ${m.action}` });
});

export const deskConsentLevelSchema = msg('desk.consent_level', {
  sessionId,
  level: anyConsentLevel,
  requested: z.boolean().optional(),
  opId: opIdSchema.optional(),
});
export const deskConsentBackstageSchema = msg('desk.consent_backstage', { sessionId, backstage: z.boolean() });

const relayData = z
  .string()
  .max(LIMITS.mirrorRelayDataChars)
  .regex(/^[A-Za-z0-9_-]*$/, 'expected base64url');
/** WS mirror relay (Phase B 4.6, Y22): one slice of a frame payload; `kind: 'json'` is always a single part. */
export const mirrorRelaySchema = msg('mirror.relay', {
  sessionId,
  tabId: z.number().int().nonnegative().max(0xffffffff),
  seq: z.number().int().nonnegative().max(0xffffffff),
  kind: z.enum(['batch', 'snapshot', 'json']),
  enc: z.enum(['none', 'deflate']),
  part: z.number().int().min(1).max(LIMITS.mirrorRelayMaxParts),
  parts: z.number().int().min(1).max(LIMITS.mirrorRelayMaxParts),
  data: relayData,
}).superRefine((m, ctx) => {
  if (m.part > m.parts) ctx.addIssue({ code: 'custom', path: ['part'], message: 'part must be <= parts' });
  if (m.kind === 'json' && (m.tabId !== 0 || m.seq !== 0 || m.enc !== 'none' || m.part !== 1 || m.parts !== 1))
    ctx.addIssue({
      code: 'custom',
      path: ['kind'],
      message: 'json relay frames have tabId 0, seq 0, enc none, part = parts = 1',
    });
});
/** WS control relay (Phase B 4.6): one `ia.control` message. */
export const controlRelaySchema = msg('control.relay', { sessionId, msg: controlMessageSchema });
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
  /** Null for the P4 desktop worker (a device session has no token, Phase D W29). */
  tokenId: uuidSchema.nullable(),
  tier: packageTierSchema,
  technician: z.object({ name: z.string() }).nullable(),
  org: brandingPublicSchema,
  region: regionSchema,
  resume: z.object({ sessionId, state: sessionStateSchema, consentState: consentStateSchema }).optional(),
  /** Phase C section 7.2: the fresh resume key of an elevated hand-over (present only on a hand-over). */
  resumeKey: z.string().min(1).max(256).optional(),
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
  /** P2 sessions only (both copies): the org extension policy in force for this session. */
  extension: z.object({ policy: extensionPolicySchema }).optional(),
  sessionId,
  /** Null for a P4 device session (Phase D W29: `session.token_id` is null, `device_id` set). */
  tokenId: uuidSchema.nullable(),
  tier: packageTierSchema,
  state: sessionStateSchema,
  consentState: consentStateSchema,
  assist: userRefSchema,
  desk: z.object({ label: z.string() }),
  org: brandingPublicSchema,
  polite: z.boolean(),
  /** Phase A.2 M2: the session's recording policy snapshot (always sent; optional for pre-A.2 fixtures). */
  recordingMode: z.enum(RECORDING_MODES).optional(),
  /** Phase C section 8.3: P3 sessions only (both copies), the org's pinned playbook manifest. */
  agent: sessionAgentSchema.optional(),
  /** Phase D section 3.5 step 4: P4 only, the device and its identity public key (rule 3.5b attestation). */
  device: z
    .object({
      id: uuidSchema,
      name: z.string(),
      keyId: z.string().regex(/^[0-9a-f]{16}$/),
      publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .optional(),
  unattended: z.boolean().optional(),
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
  level: anyConsentLevel.optional(),
  scope: mirrorScope.optional(),
  backstage: z.boolean().optional(),
  monitors: z.number().int().min(1).max(LIMITS.monitorsMax).optional(),
  clipboard: z.boolean().optional(),
});
export const consentLevelOkSchema = msg('consent.level_ok', {
  sessionId,
  level: anyConsentLevel,
  backstage: z.boolean(),
  clipboard: z.boolean().optional(),
});
/** `source` (Phase A.2 section 5): absent = `assist`. */
export const sessionRecordingSchema = msg('session.recording', {
  sessionId,
  recording: z.boolean(),
  source: z.enum(RECORDING_SOURCES).optional(),
});
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
  /** Phase A.2 U3: the server recorder joined this session. */
  serverRecording: z.boolean().optional(),
});
export const eventOkSchema = msg('event.ok', { sessionId, entryId: uuidSchema });
export const signalErrorSchema = msg('error', {
  code: z.enum(SIGNAL_ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
