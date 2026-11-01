/**
 * Phase D audit actions (docs/specs/phase-d-contracts.md section 13.3): the chain shapes of every new action (strict,
 * strings sanitised before hashing) and the P4 `desk.event` wire branches the desktop worker reports. Every action has
 * exactly one actor: `device` (attested by a device signature), `system` (derived or dispatched by the server), `desk`
 * (the session's desktop worker) or `user` (a technician or admin request).
 */
import { z } from 'zod';
import {
  APPROVED_BY,
  DEVICE_ACTION_KINDS,
  DEVICE_PLATFORMS,
  LIMITS,
  LOCK_CHANGE_CAUSES,
  PLAYBOOK_RAN_AS,
  SECURE_DESKTOP_SURFACES,
  TAMPER_CAUSES,
  WAKE_FAIL_CAUSES,
  WAKE_METHODS,
  AMT_BOOT_TARGETS,
} from '../enums.js';
import { unattendedPolicySchema } from '../fleet/policy.js';
import { sanitiseText } from './sanitise.js';

const id = z.string().transform((s) => sanitiseText(s, 100));
const text = (n: number) => z.string().transform((s) => sanitiseText(s, n));
const reason = text(LIMITS.reasonMax);
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
const kid = z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex-char key id');
const fields = z.array(text(40)).max(30);
const device = z.strictObject({ deviceId: id });

/** P4 `desk.event` wire `data` per action (the worker's C section 3.8 outbox; actor `desk`). */
export const DESK_EVENT_P4_DATA = {
  'capture.secure_desktop': z.strictObject({ surface: z.enum(SECURE_DESKTOP_SURFACES), durationMs: int }),
  'input.lock_changed': z.strictObject({ locked: z.boolean(), cause: z.enum(LOCK_CHANGE_CAUSES) }),
  'privacy.screen_changed': z.strictObject({ on: z.boolean(), cause: z.enum(LOCK_CHANGE_CAUSES) }),
  'input.sas_sent': z.strictObject({}),
  'session.local_user_arrived': z.strictObject({ decision: z.enum(['continue', 'ended']), levelDroppedTo: z.literal('view').nullable() }),
} as const;
export const DESK_EVENT_P4_ACTIONS = Object.keys(DESK_EVENT_P4_DATA) as (keyof typeof DESK_EVENT_P4_DATA)[];
export type DeskEventP4Action = keyof typeof DESK_EVENT_P4_DATA;

/** Chain `data` of the Phase D actions (merged into AUDIT_ACTIONS / auditDataSchema by actions.ts). */
export const P4_CHAIN_SCHEMAS = {
  'device.enrolled': z.strictObject({
    deviceId: id,
    tokenId: id,
    keyId: kid,
    platform: z.enum(DEVICE_PLATFORMS),
    groupId: id.nullable(),
    devicesEnrolled: int,
    maxDevices: int,
  }),
  'device.superseded': z.strictObject({ fromDeviceId: id, toDeviceId: id }),
  'device.key_rotation_armed': device,
  'device.key_rotated': z.strictObject({ deviceId: id, fromKeyId: kid, toKeyId: kid }),
  'device.updated': z.strictObject({ deviceId: id, fields }),
  'device.disabled': device,
  'device.enabled': device,
  'device.retired': device,
  'device.deregistered': device,
  'device.enroll_config_issued': z.strictObject({ tokenId: id, groupId: id.nullable() }),
  'user.device_groups_changed': z.strictObject({ userId: id, groupIds: z.array(id).max(LIMITS.deviceGroupsPerOrgMax).nullable() }),
  'device_group.created': z.strictObject({ groupId: id, fields: fields.optional() }),
  'device_group.updated': z.strictObject({ groupId: id, fields: fields.optional() }),
  'device_group.deleted': z.strictObject({ groupId: id, fields: fields.optional() }),
  'session.unattended_started': z.strictObject({
    approvedBy: z.enum(APPROVED_BY),
    policySnapshot: unattendedPolicySchema,
    reason: reason.nullable(),
  }),
  'session.local_user_arrived': DESK_EVENT_P4_DATA['session.local_user_arrived'],
  'capture.secure_desktop': DESK_EVENT_P4_DATA['capture.secure_desktop'],
  'input.lock_changed': DESK_EVENT_P4_DATA['input.lock_changed'],
  'privacy.screen_changed': DESK_EVENT_P4_DATA['privacy.screen_changed'],
  'input.sas_sent': DESK_EVENT_P4_DATA['input.sas_sent'],
  'session.protections_released': z.strictObject({ inputLock: z.boolean(), privacyScreen: z.boolean() }),
  'consent.receipt_sent': z.strictObject({
    sessionId: id.nullable(),
    actionIds: z.array(id).max(1000),
    channel: z.enum(['email', 'device']),
    toHash: hash.nullable(),
    delivered: z.boolean(),
    cause: z.enum(['no_address', 'no_mailer', 'send_failed']).optional(),
  }),
  'device.wake_requested': z.strictObject({ deviceId: id, wakeId: id, method: z.enum(WAKE_METHODS), reason: reason.nullable() }),
  'device.wake_dispatched': z.strictObject({ deviceId: id, wakeId: id, viaDeviceId: id }),
  'device.amt_poweron': z.strictObject({ deviceId: id, wakeId: id, viaDeviceId: id }),
  'device.woke': z.strictObject({ deviceId: id, wakeId: id, method: z.enum(WAKE_METHODS), via: id.nullable(), elapsedMs: int }),
  'device.wake_failed': z.strictObject({ deviceId: id, wakeId: id, method: z.enum(WAKE_METHODS), cause: z.enum(WAKE_FAIL_CAUSES) }),
  'device.amt_sol_opened': z.strictObject({ deviceId: id, solId: id, viaDeviceId: id, reason }),
  'device.amt_sol_closed': z.strictObject({ deviceId: id, solId: id, durationMs: int, transcriptSha256: hash.nullable() }),
  'device.amt_boot_redirected': z.strictObject({
    deviceId: id,
    cmdId: id,
    target: z.enum(AMT_BOOT_TARGETS),
    viaDeviceId: id,
    reason,
  }),
  'device.action_queued': z.strictObject({ actionId: id, deviceId: id, kind: z.enum(DEVICE_ACTION_KINDS), reason: reason.nullable() }),
  'device.action_dispatched': z.strictObject({ actionId: id, deviceId: id, kind: z.enum(DEVICE_ACTION_KINDS) }),
  'device.action_cancelled': z.strictObject({ actionId: id, deviceId: id, kind: z.enum(DEVICE_ACTION_KINDS) }),
  'device.action_started': z.strictObject({ actionId: id, deviceId: id, kind: z.enum(DEVICE_ACTION_KINDS), approvedBy: z.enum(APPROVED_BY) }),
  'device.action_completed': z.strictObject({
    actionId: id,
    deviceId: id,
    kind: z.enum(DEVICE_ACTION_KINDS),
    state: z.enum(['done', 'failed']),
    exit: z.number().int().optional(),
    ranAs: z.enum(PLAYBOOK_RAN_AS).optional(),
  }),
  'secret.injected': z.strictObject({
    actionId: id,
    deviceId: id,
    refs: z.array(z.strictObject({ env: text(64), path: text(256) })).max(8),
    reason: reason.nullable(),
  }),
  'tamper.alert': z.strictObject({ deviceId: id, eventId: id, cause: z.enum(TAMPER_CAUSES), at: text(40), detail: text(500).nullable() }),
  'tamper.suspected': z.strictObject({ deviceId: id, lastSeenAt: text(40).nullable(), silentSec: int }),
  'tamper.acknowledged': z.strictObject({ deviceId: id, cause: text(40).nullable(), note: text(500).nullable() }),
} as const;

export const P4_AUDIT_ACTIONS = Object.keys(P4_CHAIN_SCHEMAS) as (keyof typeof P4_CHAIN_SCHEMAS)[];
export type P4AuditAction = keyof typeof P4_CHAIN_SCHEMAS;

/** The single actor type of each P4 action (section 13.3); `insertAuditEntry` callers follow it. */
export const P4_ACTION_ACTORS: Record<P4AuditAction, 'user' | 'system' | 'desk' | 'device'> = {
  'device.enrolled': 'system',
  'device.superseded': 'system',
  'device.key_rotation_armed': 'user',
  'device.key_rotated': 'device',
  'device.updated': 'user',
  'device.disabled': 'user',
  'device.enabled': 'user',
  'device.retired': 'user',
  'device.deregistered': 'device',
  'device.enroll_config_issued': 'user',
  'user.device_groups_changed': 'user',
  'device_group.created': 'user',
  'device_group.updated': 'user',
  'device_group.deleted': 'user',
  'session.unattended_started': 'system',
  'session.local_user_arrived': 'desk',
  'capture.secure_desktop': 'desk',
  'input.lock_changed': 'desk',
  'privacy.screen_changed': 'desk',
  'input.sas_sent': 'desk',
  'session.protections_released': 'system',
  'consent.receipt_sent': 'system',
  'device.wake_requested': 'user',
  'device.wake_dispatched': 'system',
  'device.amt_poweron': 'system',
  'device.woke': 'system',
  'device.wake_failed': 'system',
  'device.amt_sol_opened': 'user',
  'device.amt_sol_closed': 'system',
  'device.amt_boot_redirected': 'user',
  'device.action_queued': 'user',
  'device.action_dispatched': 'system',
  'device.action_cancelled': 'user',
  'device.action_started': 'device',
  'device.action_completed': 'device',
  'secret.injected': 'system',
  'tamper.alert': 'device',
  'tamper.suspected': 'system',
  'tamper.acknowledged': 'user',
};

/** `device:<first 8 chars>` (Phase D conventions): the actor label of a device-attested entry. */
export function deviceActorLabel(deviceId: string): string {
  return `device:${deviceId.slice(0, 8)}`;
}
