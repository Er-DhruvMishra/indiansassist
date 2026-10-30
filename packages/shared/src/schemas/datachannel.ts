/**
 * WebRTC data channel protocol (contracts section 8): JSON message schemas for `ia.chat`, `ia.annot`,
 * `ia.file`, `ia.ctrl`, the `DataChannelMessage` union keyed on `t`, and the binary file chunk codec.
 */
import { z } from 'zod';
import { DEFAULT_ANNOT_COLOR, LIMITS, MIRROR_TRANSPORTS } from '../enums.js';
import { epochMsSchema, hex64Schema, hexColorSchema, sideSchema, uint32Schema, uuidSchema } from './common.js';
import { controlEventSchema, controlRequestSchema, controlResponseSchema, tabInfoSchema } from '../extension/control.js';
import { agentControlEventSchema, agentControlRequestSchema } from '../agent/control.js';
import { pbEndSchema, pbOutputSchema } from '../agent/playbook.js';
import { secCommitSchema, secConfirmSchema, secFailSchema, secHelloSchema } from '../agent/sec.js';
import { agentStatsSchema } from './signal-messages-p3.js';

const ts = epochMsSchema;
const unit = z.number().min(0).max(1);
export const pointSchema = z.object({ x: unit, y: unit });

// ---------- ia.chat (8.1) ----------

export const dcChatSchema = z.object({
  t: z.literal('chat'),
  msgId: uuidSchema,
  from: sideSchema,
  text: z.string().max(4000),
  ts,
});
export const dcChatAckSchema = z.object({ t: z.literal('chat.ack'), msgId: uuidSchema, ts });
export const dcTypingSchema = z.object({ t: z.literal('typing'), from: sideSchema, active: z.boolean(), ts });

// ---------- ia.annot (8.2) ----------

const color = hexColorSchema.default(DEFAULT_ANNOT_COLOR);
const ttlMs = z.number().int().min(1).max(LIMITS.annotTtlMaxMs).default(LIMITS.annotTtlDefaultMs);
/** Required in P2 (coordinates relative to that tab's viewport, Y8); the extension drops messages without it. */
const annotTabId = z.number().int().nonnegative().max(0x7fffffff).optional();
/** Required in P3 (Phase C section 3.6 M4, W15): coordinates are relative to that monitor's video frame. */
const annotMonitorId = z.number().int().min(1).max(LIMITS.monitorsMax).optional();
const box = {
  t: z.literal('annot'),
  id: uuidSchema,
  a: pointSchema,
  b: pointSchema,
  color,
  ttlMs,
  ts,
  tabId: annotTabId,
  monitorId: annotMonitorId,
};

export const annotArrowSchema = z.object({ ...box, shape: z.literal('arrow') });
export const annotRectSchema = z.object({ ...box, shape: z.literal('rect') });
export const annotHighlightSchema = z.object({ ...box, shape: z.literal('highlight') });
export const annotPointerSchema = z.object({
  t: z.literal('annot'),
  id: uuidSchema,
  shape: z.literal('pointer'),
  at: pointSchema,
  color,
  ts,
  tabId: annotTabId,
  monitorId: annotMonitorId,
});
export const annotClearSchema = z.object({
  t: z.literal('annot'),
  shape: z.literal('clear'),
  ts,
  tabId: annotTabId,
  monitorId: annotMonitorId,
});

export const dcAnnotSchema = z.discriminatedUnion('shape', [
  annotArrowSchema,
  annotRectSchema,
  annotHighlightSchema,
  annotPointerSchema,
  annotClearSchema,
]);

/** Rounds a normalised coordinate to 4 decimals (section 8.2). */
export function roundCoord(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
}

// ---------- ia.file (8.3) ----------

export const dcFileOfferSchema = z
  .object({
    t: z.literal('file.offer'),
    fileId: uint32Schema,
    name: z.string().max(1024),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mime: z.string().max(255),
    sha256: hex64Schema,
    chunkSize: z.literal(LIMITS.fileChunkSize),
    chunks: z.number().int().nonnegative(),
    ts,
  })
  .refine((o) => o.chunks === Math.ceil(o.size / LIMITS.fileChunkSize), {
    message: 'chunks must equal ceil(size / 16384)',
    path: ['chunks'],
  });
export const dcFileAcceptSchema = z.object({ t: z.literal('file.accept'), fileId: uint32Schema, ts });
export const dcFileRejectSchema = z.object({
  t: z.literal('file.reject'),
  fileId: uint32Schema,
  reason: z.enum(['declined', 'too_large', 'busy', 'bad_name']),
  ts,
});
export const dcFileDoneSchema = z.object({ t: z.literal('file.done'), fileId: uint32Schema, ts });
export const dcFileAckSchema = z.object({
  t: z.literal('file.ack'),
  fileId: uint32Schema,
  ok: z.boolean(),
  sha256: hex64Schema,
  ts,
});
export const dcFileCancelSchema = z.object({
  t: z.literal('file.cancel'),
  fileId: uint32Schema,
  reason: z.enum(['aborted', 'bad_chunk', 'overflow', 'hash_mismatch']).optional(),
  ts,
});

// ---------- ia.ctrl (8.4) ----------

export const dcStopSharingSchema = z.object({ t: z.literal('stop.sharing'), ts });
export const dcConsentRevokedSchema = z.object({ t: z.literal('consent.revoked'), ts });
export const dcRecordingStateSchema = z.object({ t: z.literal('recording.state'), recording: z.boolean(), ts });
export const dcVoiceStateSchema = z.object({ t: z.literal('voice.state'), from: sideSchema, muted: z.boolean(), ts });
export const dcPingSchema = z.object({ t: z.literal('ping'), ts });
export const dcPongSchema = z.object({ t: z.literal('pong'), ts });

// ---------- ia.mirror JSON text frames (Phase B 4.5) ----------

const tabRef = z.number().int().nonnegative().max(0x7fffffff);
const seq = z.number().int().nonnegative().max(0xffffffff);
export const dcMirrorTabsSchema = z.object({
  t: z.literal('mirror.tabs'),
  tabs: z.array(tabInfoSchema).max(500),
  hiddenCount: z.number().int().nonnegative(),
  activeTabId: tabRef.nullable(),
  focusedTabId: tabRef.nullable(),
  ts,
});
export const MIRROR_TAB_STATES = [
  'attached',
  'detached',
  'paused',
  'resumed',
  'denied',
  'too_large',
  'navigated',
  'revealed',
  'restored',
] as const;
export const dcMirrorTabSchema = z.object({
  t: z.literal('mirror.tab'),
  tab: tabInfoSchema,
  state: z.enum(MIRROR_TAB_STATES),
  transport: z.enum(MIRROR_TRANSPORTS).optional(),
  ts,
});
export const dcMirrorAckSchema = z.object({ t: z.literal('mirror.ack'), tabId: tabRef, seq, ts });
export const dcMirrorNackSchema = z.object({ t: z.literal('mirror.nack'), tabId: tabRef, seq, ts });

/** Every data channel JSON message, discriminated on `t` (annotations nest a union on `shape`). */
export const dataChannelMessageSchema = z.discriminatedUnion('t', [
  dcChatSchema,
  dcChatAckSchema,
  dcTypingSchema,
  dcAnnotSchema,
  dcFileOfferSchema,
  dcFileAcceptSchema,
  dcFileRejectSchema,
  dcFileDoneSchema,
  dcFileAckSchema,
  dcFileCancelSchema,
  dcStopSharingSchema,
  dcConsentRevokedSchema,
  dcRecordingStateSchema,
  dcVoiceStateSchema,
  dcPingSchema,
  dcPongSchema,
  dcMirrorTabsSchema,
  dcMirrorTabSchema,
  dcMirrorAckSchema,
  dcMirrorNackSchema,
  controlRequestSchema,
  controlResponseSchema,
  controlEventSchema,
  // Phase C: ia.sec handshake, ia.playbook output and agent.stats on ia.ctrl
  secCommitSchema,
  secHelloSchema,
  secConfirmSchema,
  secFailSchema,
  pbOutputSchema,
  pbEndSchema,
  agentStatsSchema,
]);
export type DataChannelMessage = z.infer<typeof dataChannelMessageSchema>;

/** A P3 `ia.control` message (section 5.1): a native op, the shared `ctl.res`, a native event or the B `prompt` event. */
export const agentControlMessageSchema = z.union([agentControlRequestSchema, controlResponseSchema, agentControlEventSchema, controlEventSchema]);
export type AgentControlMessage = z.infer<typeof agentControlMessageSchema>;
export type DataChannelType = DataChannelMessage['t'];

/** Which `t` values belong on which channel label. */
export const DATA_CHANNEL_TYPES = {
  'ia.chat': ['chat', 'chat.ack', 'typing'],
  'ia.annot': ['annot'],
  'ia.file': ['file.offer', 'file.accept', 'file.reject', 'file.done', 'file.ack', 'file.cancel'],
  'ia.ctrl': ['stop.sharing', 'consent.revoked', 'recording.state', 'voice.state', 'ping', 'pong', 'agent.stats'],
  'ia.mirror': ['mirror.tabs', 'mirror.tab', 'mirror.ack', 'mirror.nack'],
  'ia.control': ['ctl.req', 'ctl.res', 'ctl.event'],
  // Phase C sections 1.3, 5.1
  'ia.sec': ['sec.commit', 'sec.hello', 'sec.confirm', 'sec.fail'],
  'ia.playbook': ['pb.output', 'pb.end'],
} as const satisfies Record<string, readonly DataChannelType[]>;

export type DataChannelParseResult =
  | { ok: true; msg: DataChannelMessage | AgentControlMessage }
  | { ok: false; reason: 'bad_json' | 'bad_payload' | 'wrong_channel'; issues?: z.core.$ZodIssue[] };

/**
 * Parses a JSON text frame received on `label`. A message whose `t` does not belong to the channel is
 * rejected (`wrong_channel`). Messages with a `from` that does not match `expectedFrom` (the peer) are
 * rejected as `bad_payload` (section 8: the receiver ignores a mismatched `from`).
 */
export function parseDataChannelMessage(
  label: keyof typeof DATA_CHANNEL_TYPES,
  text: string,
  expectedFrom?: 'assist' | 'desk',
): DataChannelParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
  let parsed = dataChannelMessageSchema.safeParse(value) as
    | { success: true; data: DataChannelMessage | AgentControlMessage }
    | { success: false; error: z.ZodError };
  // A P3 session's ia.control carries the native ops and events (section 5.1), disjoint from the B ops.
  if (!parsed.success && label === 'ia.control') {
    const agent = agentControlMessageSchema.safeParse(value);
    if (agent.success) parsed = agent;
  }
  if (!parsed.success) return { ok: false, reason: 'bad_payload', issues: parsed.error.issues };
  const allowed = DATA_CHANNEL_TYPES[label] as readonly string[];
  if (!allowed.includes(parsed.data.t)) return { ok: false, reason: 'wrong_channel' };
  if (expectedFrom !== undefined && 'from' in parsed.data && parsed.data.from !== expectedFrom)
    return { ok: false, reason: 'bad_payload' };
  return { ok: true, msg: parsed.data };
}

// ---------- binary file chunks (8.3) ----------

export type FileChunk = { fileId: number; chunkIndex: number; payload: Uint8Array };

/** `[0,4)` uint32 BE fileId, `[4,8)` uint32 BE chunkIndex, `[8, 8+n)` payload with n <= 16384. */
export function encodeFileChunk(fileId: number, chunkIndex: number, payload: Uint8Array): Uint8Array {
  if (payload.length > LIMITS.fileChunkSize) throw new Error('chunk payload exceeds 16384 bytes');
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 0xffffffff) throw new Error('fileId must be uint32');
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 0xffffffff)
    throw new Error('chunkIndex must be uint32');
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, fileId, false);
  view.setUint32(4, chunkIndex, false);
  out.set(payload, 8);
  return out;
}

/** Decodes a binary chunk frame; returns null when the frame is shorter than the header or too long. */
export function decodeFileChunk(frame: ArrayBuffer | Uint8Array): FileChunk | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length < 8 || bytes.length > 8 + LIMITS.fileChunkSize) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { fileId: view.getUint32(0, false), chunkIndex: view.getUint32(4, false), payload: bytes.subarray(8) };
}
