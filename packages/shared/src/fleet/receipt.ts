/**
 * Phase D consent receipts (docs/specs/phase-d-contracts.md section 6.4): built by the server from the chain at
 * session end (`DeviceReceipt`) and for each finished device action (`DeviceActionReceipt`); delivered to the device
 * (`device.receipt`) and, for unattended sessions and every action, mailed to the notify address.
 */
import { z } from 'zod';
import {
  AGENT_CONSENT_LEVELS,
  APPROVED_BY,
  DEVICE_ACTION_KINDS,
  DEVICE_ACTION_STATES,
  LOCK_CHANGE_CAUSES,
  RECORDING_MODES,
  SECURE_DESKTOP_SURFACES,
  SESSION_END_REASONS,
} from '../enums.js';
import { unattendedPolicySchema } from './policy.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid');
const iso = z.string();
const toggle = z.strictObject({ on: z.boolean(), at: iso, cause: z.enum(LOCK_CHANGE_CAUSES).nullable() });

export const deviceReceiptSchema = z.strictObject({
  sessionId: uuid,
  deviceId: uuid,
  deviceName: z.string(),
  org: z.strictObject({ displayName: z.string() }),
  technician: z.strictObject({ name: z.string() }),
  reason: z.string().nullable(),
  unattended: z.boolean(),
  approvedBy: z.enum(APPROVED_BY).nullable(),
  policySnapshot: unattendedPolicySchema.nullable(),
  startedAt: iso.nullable(),
  endedAt: iso,
  endReason: z.enum(SESSION_END_REASONS),
  durationMs: z.number().int().nonnegative().nullable(),
  monitorsShared: z.number().int().min(1).max(16).nullable(),
  levelChanges: z.array(z.strictObject({ from: z.string(), to: z.enum(AGENT_CONSENT_LEVELS), at: iso })),
  clipboard: z.boolean().nullable(),
  elevation: z.strictObject({ granted: z.boolean() }),
  playbooks: z.array(z.strictObject({ playbookId: z.string(), runId: z.string(), exit: z.number().int().nullable(), ranAs: z.string() })),
  sas: z.array(z.strictObject({ gen: z.number().int().nonnegative(), method: z.enum(['read_out', 'device_key', 'skipped']) })),
  secureDesktop: z.array(z.strictObject({ surface: z.enum(SECURE_DESKTOP_SURFACES), durationMs: z.number().int().nonnegative() })),
  inputLock: z.array(toggle),
  privacyScreen: z.array(toggle),
  localUserArrived: z.array(z.strictObject({ decision: z.enum(['continue', 'ended']), at: iso })),
  recording: z.strictObject({ mode: z.enum(RECORDING_MODES), recordingId: z.string().nullable() }),
  hashChainTail: z.string().nullable(),
});
export type DeviceReceipt = z.infer<typeof deviceReceiptSchema>;

export const deviceActionReceiptSchema = z.strictObject({
  actionId: uuid,
  deviceId: uuid,
  kind: z.enum(DEVICE_ACTION_KINDS),
  name: z.string(),
  technician: z.strictObject({ name: z.string() }),
  reason: z.string().nullable(),
  approvedBy: z.enum(APPROVED_BY).nullable(),
  state: z.enum(DEVICE_ACTION_STATES),
  startedAt: iso.nullable(),
  completedAt: iso.nullable(),
});
export type DeviceActionReceipt = z.infer<typeof deviceActionReceiptSchema>;

/** `device.receipt.receipt`: a session receipt (has `sessionId`) or an action receipt (has `actionId`). */
export const anyDeviceReceiptSchema = z.union([deviceReceiptSchema, deviceActionReceiptSchema]);
