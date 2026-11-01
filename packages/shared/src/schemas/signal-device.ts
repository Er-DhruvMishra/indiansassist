/**
 * Phase D `/signal/device` messages (docs/specs/phase-d-contracts.md sections 3.4, 3.7b, 4.2, 6.4b, 8.2b, 8.4b, 9.1,
 * 9.7, 10.2) and the S->A pushes on `/signal` (`device.woke`, `device.wake_failed`, `amt.sol.data`). Envelope as
 * Phase A section 7.1. Only these, `error`, `ping` and `pong` travel on `/signal/device`; no device frame is ever
 * sent on `/signal`.
 */
import { z } from 'zod';
import { LIMITS, AMT_BOOT_TARGETS, AMT_OPS, APPROVED_BY, CONSENT_DECISIONS, DEVICE_ACTION_KINDS, RECORDING_MODES, WAKE_FAIL_CAUSES, WAKE_METHODS } from '../enums.js';
import { epochMsSchema, isoTimestampSchema, regionSchema, uuidSchema } from './common.js';
import { signalErrorSchema, pingSchema, pongSchema } from './signal-messages.js';
import { playbookManifestSchema } from '../agent/playbook.js';
import { amtInventorySchema, b64u16Schema, b64u32Schema, b64u64Schema, interactiveStateSchema, lanSegmentSchema, serviceCapabilitiesSchema, wakeMacSchema } from '../fleet/device.js';
import { deviceActionResultSchema, deviceActionSchema } from '../fleet/actions.js';
import { unattendedPolicySchema } from '../fleet/policy.js';
import { sealedSchema } from '../fleet/seal.js';
import { tamperEventSchema } from '../fleet/tamper.js';
import { anyDeviceReceiptSchema } from '../fleet/receipt.js';

const envelope = { id: z.string().max(64).optional(), re: z.string().max(64).optional(), ts: epochMsSchema.optional() };
function msg<T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  return z.object({ t: z.literal(t), ...envelope, ...shape });
}
/** A worker credential: 32 CSPRNG bytes, base64url (43 characters). */
export const workerCredentialSchema = b64u32Schema;
const gen = z.number().int().min(0).max(65535);

// ---------- S -> D ----------

export const deviceChallengeSchema = msg('device.challenge', { serverChallenge: b64u32Schema, ts: epochMsSchema });
export const deviceHelloOkSchema = msg('device.hello.ok', {
  deviceId: uuidSchema,
  orgDisplayName: z.string(),
  region: regionSchema,
  policy: unattendedPolicySchema,
  groupId: uuidSchema.nullable(),
  queued: z.array(deviceActionSchema).max(LIMITS.deviceQueueDrainMax),
  playbooks: z.array(playbookManifestSchema).max(LIMITS.playbookCatalogueMax),
  rotationNonce: b64u16Schema.nullable(),
});
export const deviceSessionOpenSchema = msg('device.session_open', {
  sessionId: uuidSchema,
  assist: z.object({ name: z.string() }),
  reason: z.string().nullable(),
  unattended: z.boolean(),
  decision: z.enum(CONSENT_DECISIONS),
  policy: unattendedPolicySchema,
  recordingMode: z.enum(RECORDING_MODES),
  workerCredential: workerCredentialSchema,
  workerCredentialExpiresAt: isoTimestampSchema,
});
export const deviceWorkerCredentialSchema = msg('device.worker_credential', {
  sessionId: uuidSchema,
  gen,
  workerCredential: workerCredentialSchema,
  expiresAt: isoTimestampSchema,
});
/** `device.action` (rule 9.1): the REST `DeviceAction` fields the device needs, plus `technician` and `secrets`. */
export const deviceActionMsgSchema = msg('device.action', {
  actionId: uuidSchema,
  kind: z.enum(DEVICE_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
  technician: z.object({ name: z.string() }),
  secrets: z.array(z.strictObject({ env: z.string(), sealed: sealedSchema })).max(8).optional(),
});
export const devicePolicySchema = msg('device.policy', { policy: unattendedPolicySchema });
export const deviceReceiptMsgSchema = msg('device.receipt', { receipt: anyDeviceReceiptSchema });
export const deviceTamperOkSchema = msg('device.tamper.ok', { ids: z.array(uuidSchema).max(1000) });
export const deviceRotateOkSchema = msg('device.rotate.ok', { keyId: z.string().regex(/^[0-9a-f]{16}$/) });
export const wakeSendSchema = msg('wake.send', { wakeId: uuidSchema, targetMacSealed: sealedSchema });
export const amtCommandSchema = msg('amt.command', {
  cmdId: uuidSchema,
  targetDeviceId: uuidSchema,
  amtHost: z.string().max(255),
  tls: z.boolean(),
  op: z.enum(AMT_OPS),
  args: z.strictObject({ target: z.enum(AMT_BOOT_TARGETS).optional() }),
  credSealed: sealedSchema,
});

// ---------- D -> S ----------

export const deviceHelloClientSchema = z.strictObject({
  serviceVersion: z.string().min(1).max(32),
  agentVersion: z.string().min(1).max(32),
  osVersion: z.string().min(1).max(32),
  arch: z.enum(['x64', 'arm64']),
  capabilities: serviceCapabilitiesSchema,
  lanSegment: lanSegmentSchema,
  wakeMac: wakeMacSchema.nullable(),
  amt: amtInventorySchema.nullable(),
  interactive: interactiveStateSchema,
});
export const deviceHelloSchema = msg('device.hello', {
  deviceId: uuidSchema,
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  nonce: b64u16Schema,
  sig: b64u64Schema,
  client: deviceHelloClientSchema,
});
export const deviceHeartbeatSchema = msg('device.heartbeat', {
  lanSegment: lanSegmentSchema.optional(),
  wakeMac: wakeMacSchema.optional(),
  amt: amtInventorySchema.optional(),
  interactive: interactiveStateSchema.optional(),
  metrics: z
    .strictObject({ cpu: z.number().min(0).max(100), mem: z.number().min(0).max(100), uptimeSec: z.number().int().nonnegative() })
    .optional(),
});
export const deviceInteractiveSchema = msg('device.interactive', { interactive: interactiveStateSchema });
export const deviceWorkerCredentialRequestSchema = msg('device.worker_credential.request', { sessionId: uuidSchema, gen });
export const deviceActionResultMsgSchema = msg('device.action_result', {
  actionId: uuidSchema,
  state: z.enum(['awaiting_approval', 'running', 'done', 'failed']),
  approvedBy: z.enum(APPROVED_BY).optional(),
  result: deviceActionResultSchema.optional(),
  sig: b64u64Schema,
});
export const deviceTamperSchema = msg('device.tamper', { events: z.array(tamperEventSchema).min(1).max(100) });
export const deviceRotateSchema = msg('device.rotate', {
  newPublicKey: b64u32Schema,
  newKexPublicKey: b64u32Schema,
  oldKeySig: b64u64Schema,
  newKeyProof: b64u64Schema,
});
export const wakeSentSchema = msg('wake.sent', { wakeId: uuidSchema, ok: z.boolean(), error: z.string().max(200).optional() });
export const amtResultSchema = msg('amt.result', {
  cmdId: uuidSchema,
  ok: z.boolean(),
  error: z.enum(['amt_unreachable', 'auth_failed', 'unsupported', 'tls_failed']).optional(),
  powerState: z.number().int().optional(),
});
const solData = z
  .string()
  .max(Math.ceil((16 * 1024 * 4) / 3))
  .regex(/^[A-Za-z0-9_-]*$/, 'expected base64url');
export const amtSolDataSchema = msg('amt.sol.data', { cmdId: uuidSchema, seq: z.number().int().nonnegative(), data: solData });

// ---------- S -> A on /signal ----------

export const deviceWokeSchema = msg('device.woke', {
  wakeId: uuidSchema,
  deviceId: uuidSchema,
  method: z.enum(WAKE_METHODS),
  via: uuidSchema.nullable(),
  elapsedMs: z.number().int().nonnegative(),
});
export const deviceWakeFailedSchema = msg('device.wake_failed', { wakeId: uuidSchema, deviceId: uuidSchema, cause: z.enum(WAKE_FAIL_CAUSES) });
/**
 * Rule 6.2a: the worker reported that someone sat down at the device during an unattended (or pre-login) session and
 * what they chose. Same fields as the chained `desk.event session.local_user_arrived`, forwarded to the technician's
 * console so it can raise the arrival card instead of finding out at the receipt.
 */
export const sessionLocalUserArrivedSchema = msg('session.local_user_arrived', {
  sessionId: uuidSchema,
  decision: z.enum(['continue', 'ended']),
  levelDroppedTo: z.literal('view').nullable(),
});
export const amtSolDataAssistSchema = msg('amt.sol.data', { solId: uuidSchema, seq: z.number().int().nonnegative(), data: solData });

// ---------- unions ----------

/** Every message a device may send on `/signal/device`. */
export const deviceClientMessageSchema = z.discriminatedUnion('t', [
  deviceHelloSchema,
  deviceHeartbeatSchema,
  deviceInteractiveSchema,
  deviceWorkerCredentialRequestSchema,
  deviceActionResultMsgSchema,
  deviceTamperSchema,
  deviceRotateSchema,
  wakeSentSchema,
  amtResultSchema,
  amtSolDataSchema,
  pingSchema,
  pongSchema,
]);
export type DeviceClientMessage = z.infer<typeof deviceClientMessageSchema>;
export type DeviceClientOf<T extends DeviceClientMessage['t']> = Extract<DeviceClientMessage, { t: T }>;

/** Every message the server sends on `/signal/device`. */
export const deviceServerMessageSchema = z.discriminatedUnion('t', [
  deviceChallengeSchema,
  deviceHelloOkSchema,
  deviceSessionOpenSchema,
  deviceWorkerCredentialSchema,
  deviceActionMsgSchema,
  devicePolicySchema,
  deviceReceiptMsgSchema,
  deviceTamperOkSchema,
  deviceRotateOkSchema,
  wakeSendSchema,
  amtCommandSchema,
  signalErrorSchema,
  pingSchema,
  pongSchema,
]);
export type DeviceServerMessage = z.infer<typeof deviceServerMessageSchema>;

/** The `t` values a device may send (anything else on `/signal/device` is `error forbidden` + close 4403). */
export const DEVICE_CLIENT_TYPES = deviceClientMessageSchema.options.map((o) => o.shape.t.value);

export type DeviceParseResult<M> =
  | { ok: true; msg: M }
  | { ok: false; code: 'payload_too_large' | 'bad_payload' | 'unknown_type'; message: string; re?: string; issues?: z.core.$ZodIssue[] };

function parse<S extends typeof deviceClientMessageSchema | typeof deviceServerMessageSchema>(schema: S, frame: unknown): DeviceParseResult<z.infer<S>> {
  let value: unknown = frame;
  if (typeof frame === 'string') {
    if (new TextEncoder().encode(frame).length > LIMITS.maxWsFrameBytes) return { ok: false, code: 'payload_too_large', message: 'frame exceeds 64 KiB' };
    try {
      value = JSON.parse(frame);
    } catch {
      return { ok: false, code: 'bad_payload', message: 'frame is not valid JSON' };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'bad_payload', message: 'frame must be a JSON object' };
  const obj = value as Record<string, unknown>;
  const re = typeof obj['id'] === 'string' ? (obj['id'] as string) : undefined;
  const known = new Set(schema.options.map((o) => (o as unknown as { shape: { t: { value: string } } }).shape.t.value));
  if (typeof obj['t'] !== 'string' || !known.has(obj['t'] as string))
    return { ok: false, code: 'unknown_type', message: 'unknown message type', ...(re !== undefined ? { re } : {}) };
  const r = schema.safeParse(obj);
  if (!r.success) return { ok: false, code: 'bad_payload', message: `invalid ${String(obj['t'])} payload`, issues: r.error.issues, ...(re !== undefined ? { re } : {}) };
  return { ok: true, msg: r.data as z.infer<S> };
}

/** Server side of `/signal/device`. */
export function parseDeviceClientMessage(frame: unknown): DeviceParseResult<DeviceClientMessage> {
  return parse(deviceClientMessageSchema, frame);
}

/** Device side of `/signal/device` (the smoke's simulated device; the service parses with serde). */
export function parseDeviceServerMessage(frame: unknown): DeviceParseResult<DeviceServerMessage> {
  return parse(deviceServerMessageSchema, frame);
}
