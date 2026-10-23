/** REST schemas: sessions, audit, recordings, ICE, residency (contracts 6.3, 6.8-6.11). */
import { z } from 'zod';
import { CONSENT_LEVELS, DESK_BROWSERS, DESK_CLIENT_KINDS, DESK_OSES, LIMITS, MIRROR_SCOPES, RRWEB_RECORDING_MIME, SESSION_END_REASONS } from '../enums.js';
import { ASSIST_EVENT_DATA, ASSIST_EVENT_REASON_ACTIONS, type AssistEventP2Action } from '../audit/actions-p2.js';
import {
  actorTypeSchema,
  consentStateSchema,
  consentSurfaceSchema,
  fileDirectionSchema,
  hex64Schema,
  iceConfigSchema,
  isoDateTimeInputSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  kidSchema,
  packageTierSchema,
  participantRoleSchema,
  recordingStatusSchema,
  regionSchema,
  sessionEndReasonSchema,
  sessionPathSchema,
  sessionStateSchema,
  uint32Schema,
  userRefSchema,
  uuidSchema,
  verifyFailureSchema,
} from './common.js';
import { pageSchema } from './rest-core.js';

// ---------- sessions (6.8) ----------

export const sessionSchema = z.object({
  id: uuidSchema,
  tokenId: uuidSchema,
  tokenCreatedBy: userRefSchema,
  assist: userRefSchema,
  deskLabel: z.string().nullable(),
  tier: packageTierSchema,
  state: sessionStateSchema,
  consentState: consentStateSchema,
  consentSurface: consentSurfaceSchema.nullable(),
  path: sessionPathSchema,
  region: regionSchema,
  nodeId: z.string(),
  knockedAt: isoTimestampSchema,
  acceptedAt: isoTimestampSchema.nullable(),
  consentAt: isoTimestampSchema.nullable(),
  startedAt: isoTimestampSchema.nullable(),
  endedAt: isoTimestampSchema.nullable(),
  endReason: sessionEndReasonSchema.nullable(),
  lastStats: jsonObjectSchema.nullable(),
  recordingStarted: z.boolean(),
  recordingId: uuidSchema.nullable(),
  hashChainTail: hex64Schema.nullable(),
  // Phase B 11.1 (nullable; always sent by the api, optional so Phase A fixtures still parse).
  consentLevel: z.enum(CONSENT_LEVELS).nullable().optional(),
  consentScope: z.enum(MIRROR_SCOPES).nullable().optional(),
  consentBackstage: z.boolean().nullable().optional(),
  deskClient: z
    .object({
      kind: z.enum(DESK_CLIENT_KINDS),
      version: z.string().optional(),
      browser: z.object({ name: z.enum(DESK_BROWSERS), version: z.string() }).optional(),
      os: z.enum(DESK_OSES).optional(),
    })
    .nullable()
    .optional(),
});

export const sessionFileSchema = z.object({
  fileId: uint32Schema,
  direction: fileDirectionSchema,
  name: z.string(),
  bytes: z.number().int().nonnegative(),
  assistSha256: hex64Schema.nullable(),
  deskSha256: hex64Schema.nullable(),
  match: z.boolean().nullable(),
});

export const sessionParticipantSchema = z.object({
  role: participantRoleSchema,
  label: z.string(),
  userId: uuidSchema.nullable(),
  connectionId: z.string(),
  joinedAt: isoTimestampSchema,
  leftAt: isoTimestampSchema.nullable(),
});

export const sessionDetailSchema = sessionSchema.extend({
  participants: z.array(sessionParticipantSchema),
  files: z.array(sessionFileSchema),
});

export const sessionsPageSchema = pageSchema(sessionSchema);

export const sessionsListQuerySchema = z.object({
  state: sessionStateSchema.optional(),
  from: isoDateTimeInputSchema.optional(),
  to: isoDateTimeInputSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const sessionStatsQuerySchema = z.object({
  from: isoDateTimeInputSchema.optional(),
  to: isoDateTimeInputSchema.optional(),
});

const endReasonCounts = Object.fromEntries(SESSION_END_REASONS.map((r) => [r, z.number().int().nonnegative()])) as {
  [K in (typeof SESSION_END_REASONS)[number]]: z.ZodNumber;
};

export const sessionStatsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  byPath: z.object({
    p2p: z.number().int().nonnegative(),
    relay: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  byEndReason: z.object(endReasonCounts),
  avgDurationMs: z.number().nonnegative().nullable(),
  medianRttMs: z.number().nonnegative().nullable(),
  byDay: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().nonnegative() })),
});

export const sessionEndRequestSchema = z.object({ note: z.string().max(5000).optional() });

/** `data` of a file attestation (REST `file.*` events and WS `desk.event`). */
export const fileEventDataSchema = z.object({
  fileId: uint32Schema,
  direction: fileDirectionSchema,
  name: z.string().max(1024),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: hex64Schema,
});

function assistEvent<A extends AssistEventP2Action>(action: A) {
  const withReason = (ASSIST_EVENT_REASON_ACTIONS as readonly string[]).includes(action);
  return z.strictObject({
    action: z.literal(action),
    data: ASSIST_EVENT_DATA[action],
    ...(withReason ? { reason: z.string().max(LIMITS.reasonMax).optional() } : {}),
  });
}

/**
 * POST /sessions/:id/events body (Phase A 6.8, Phase B 3.6 / Y24): file attestations, `recording.started` and the
 * console's control-op reports (`reason` only on `mask.requested` and `level.requested`).
 */
export const sessionEventRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('file.sent'), data: fileEventDataSchema }),
  z.object({ action: z.literal('file.received'), data: fileEventDataSchema }),
  z.object({ action: z.literal('recording.started'), data: z.strictObject({}) }),
  assistEvent('tab.action'),
  assistEvent('control.input'),
  assistEvent('mask.requested'),
  assistEvent('level.requested'),
  assistEvent('backstage.enter'),
  assistEvent('backstage.exit'),
]);
/** Alias named in the Phase B contracts (section 11.2). */
export const sessionEventBodySchema = sessionEventRequestSchema;

// ---------- audit (6.9) ----------

export const auditEntrySchema = z.object({
  id: uuidSchema,
  seq: z.number().int().positive(),
  sessionId: uuidSchema.nullable(),
  actor: z.object({ type: actorTypeSchema, id: z.string().nullable(), label: z.string() }),
  action: z.string(),
  reason: z.string().nullable(),
  region: regionSchema,
  ts: isoTimestampSchema,
  data: jsonObjectSchema,
  prevHash: hex64Schema,
  hash: hex64Schema,
});

export const auditPageSchema = pageSchema(auditEntrySchema);

export const auditListQuerySchema = z.object({
  action: z.string().max(100).optional(),
  sessionId: uuidSchema.optional(),
  from: isoDateTimeInputSchema.optional(),
  to: isoDateTimeInputSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export const sessionAuditResponseSchema = z.object({
  items: z.array(auditEntrySchema),
  integrity: z.object({
    ok: z.boolean(),
    checked: z.number().int().nonnegative(),
    verifiedAt: isoTimestampSchema,
    failure: verifyFailureSchema.optional(),
  }),
  files: z.array(sessionFileSchema),
  /** Phase B 11.3: `hostHash -> host` from `session_host`, for roles that may see file names. */
  hosts: z.record(z.string(), z.string()).optional(),
});

export const auditExportRequestSchema = z.object({
  from: isoDateTimeInputSchema.optional(),
  to: isoDateTimeInputSchema.optional(),
});

export const auditVerifyResponseSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int().nonnegative(),
  tail: hex64Schema.nullable(),
  failure: verifyFailureSchema.optional(),
  verifiedAt: isoTimestampSchema,
});

/** GET /audit/verify: the latest persisted verify result or null. */
export const auditLastVerifyResponseSchema = auditVerifyResponseSchema.nullable();

// ---------- recordings (6.10) ----------

/**
 * Recording media types (contracts section 9, SEC-01): an allow-list of audio / video container types, each with an
 * optional `codecs` parameter (quoted or not). Anything else (e.g. `text/html`, `application/javascript`,
 * `image/svg+xml`) is refused, because the stored value is part of the recording row and must never describe an
 * active document type. The `/file` route serves only the base type of this list, never the stored string.
 */
export const RECORDING_MEDIA_TYPES = ['video/webm', 'video/mp4', 'audio/webm', 'audio/ogg', RRWEB_RECORDING_MIME] as const;
export type RecordingMediaType = (typeof RECORDING_MEDIA_TYPES)[number];

/** Audio / video types may carry a `codecs` parameter; the rrweb JSONL type (Phase B 4.7) may not. */
export const RECORDING_MIME_RE =
  /^(?:(video\/webm|video\/mp4|audio\/webm|audio\/ogg)(;\s*codecs=("[A-Za-z0-9,.+\-\s]+"|[A-Za-z0-9,.+\-\s]+))?|(application\/x-ia-rrweb\+jsonl))$/;

/** The allow-listed base type of a recording mime, or null when it is not on the list. */
export function recordingMediaType(mime: string): RecordingMediaType | null {
  const m = RECORDING_MIME_RE.exec(mime);
  return m ? ((m[1] ?? m[4]) as RecordingMediaType) : null;
}

/** File extension for the download filename of a recording of base type `t` (`jsonl.gz` for rrweb, Phase B 4.7). */
export function recordingFileExtension(t: RecordingMediaType): string {
  if (t === RRWEB_RECORDING_MIME) return 'jsonl.gz';
  return t === 'video/mp4' ? 'mp4' : t === 'audio/ogg' ? 'ogg' : 'webm';
}

const mimeSchema = z
  .string()
  .max(255)
  .regex(RECORDING_MIME_RE, `recordings must be one of ${RECORDING_MEDIA_TYPES.join(', ')}`);

export const recordingSchema = z.object({
  id: uuidSchema,
  sessionId: uuidSchema,
  status: recordingStatusSchema,
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: hex64Schema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  storageKey: z.string(),
  chainedInto: uuidSchema.nullable(),
  region: regionSchema,
  createdAt: isoTimestampSchema,
  storedAt: isoTimestampSchema.nullable(),
  /** Phase B Y26: set when the object was deleted (manual or retention); always sent by the api. */
  deletedAt: isoTimestampSchema.nullable().optional(),
});

/** Multipart field `meta` of POST /sessions/:id/recordings (parsed from its JSON string). */
export const recordingMetaSchema = z.object({
  mime: mimeSchema,
  durationMs: z.number().int().nonnegative().optional(),
});

/** Size caps (2 GiB) answer `413 payload_too_large`, so `bytes` is not capped here; see LIMITS. */
export const recordingUploadInitRequestSchema = z.object({
  mime: mimeSchema,
  durationMs: z.number().int().nonnegative().optional(),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const recordingUploadInitResponseSchema = z.object({
  uploadId: z.string(),
  recordingId: uuidSchema,
  partSize: z.literal(16777216),
  parts: z.number().int().positive(),
});

export const recordingPartParamsSchema = z.object({
  uploadId: z.string().min(1),
  n: z.coerce.number().int().min(1),
});
export const recordingPartResponseSchema = z.object({
  n: z.number().int().min(1),
  bytes: z.number().int().nonnegative(),
});
export const recordingCompleteRequestSchema = z.object({ parts: z.number().int().positive() });
export const recordingDownloadResponseSchema = z.object({ url: z.string(), expiresAt: isoTimestampSchema });
export const recordingVerifyResponseSchema = z.object({
  ok: z.boolean(),
  sha256: hex64Schema.nullable(),
  expectedSha256: hex64Schema.nullable(),
  chainSha256: hex64Schema.nullable(),
  bytes: z.number().int().nonnegative(),
  chainedInto: uuidSchema.nullable(),
});
export const recordingFileQuerySchema = z.object({
  exp: z.coerce.number().int().nonnegative(),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});

// ---------- ICE (6.11) ----------

export const iceQuerySchema = z.object({ sessionId: uuidSchema.optional() });
export const iceResponseSchema = iceConfigSchema;

// ---------- residency (6.3) ----------

export const residencyReportSchema = z.object({
  org: z.object({ id: uuidSchema, name: z.string(), slug: z.string(), dataRegion: regionSchema }),
  generatedAt: isoTimestampSchema,
  servedBy: z.object({ region: regionSchema, apiOrigin: z.string(), nodeId: z.string() }),
  storage: z.object({ driver: z.string(), bucket: z.string(), prefix: z.string() }),
  ice: z.object({
    stunUrls: z.array(z.string()),
    turnUrls: z.array(z.string()),
    thirdPartyHosts: z.array(z.string()),
  }),
  counts: z.object({
    users: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    recordings: z.number().int().nonnegative(),
    recordingBytes: z.number().int().nonnegative(),
    auditEntries: z.number().int().nonnegative(),
  }),
  chain: z.object({
    length: z.number().int().nonnegative(),
    tail: hex64Schema.nullable(),
    lastVerifiedAt: isoTimestampSchema.nullable(),
    lastVerifiedOk: z.boolean().nullable(),
    lastAnchor: z
      .object({ seq: z.number().int().nonnegative(), tail: hex64Schema, ts: isoTimestampSchema, kid: kidSchema })
      .nullable(),
  }),
  /** Phase B 11.3 additions (always sent by the api; optional so Phase A fixtures still parse). */
  extensionPolicy: z.object({ allowRelayFallback: z.boolean(), recordRevealed: z.boolean() }).optional(),
  relaySessions: z.number().int().nonnegative().optional(),
  relayBytes: z.number().int().nonnegative().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  retention: z.object({
    auditEntries: z.literal('append-only, never deleted'),
    piiInChain: z.literal('hashed with a per-org pepper; pepper destruction is the erasure mechanism (Phase E)'),
    recordings: z.literal('until deleted by an org_admin (Phase B endpoint)'),
  }),
  statement: z.string(),
});
