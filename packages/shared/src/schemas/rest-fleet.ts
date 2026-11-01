/**
 * Phase D fleet REST schemas (docs/specs/phase-d-contracts.md sections 3.2, 3.5, 7.2, 8, 9): device list / detail /
 * patch, device sessions, deregister, AMT, actions, tamper acknowledgement, device groups, technician group
 * assignment, the org unattended and fleet policies and the enrollment config.
 */
import { z } from 'zod';
import { AMT_BOOT_TARGETS, APPROVED_BY, DEVICE_ACTION_STATES, DEVICE_STATUSES, LIMITS, SESSION_END_REASONS, SESSION_STATES } from '../enums.js';
import { sanitiseText } from '../audit/sanitise.js';
import { emailSchema, isoTimestampSchema, userRefSchema, uuidSchema } from './common.js';
import { b64u16Schema, b64u64Schema, deviceSchema, deviceTagsSchema } from '../fleet/device.js';
import { unattendedPolicyPatchSchema, unattendedPolicySchema } from '../fleet/policy.js';
import { amtInventorySchema } from '../fleet/device.js';
import { deviceActionSchema } from '../fleet/actions.js';

const reason = z
  .string()
  .max(5000)
  .transform((s) => sanitiseText(s, LIMITS.reasonMax).trim())
  .refine((s) => s.length >= 1, 'reason is 1..500 characters');
const name80 = z
  .string()
  .max(1000)
  .transform((s) => sanitiseText(s, 80).trim())
  .refine((s) => s.length >= 1, 'name is 1..80 characters');
const pageLimit = z.coerce.number().int().min(1).max(LIMITS.fleetPageMax).default(LIMITS.pageLimitDefault);
const cursor = z.string().min(1).max(512).optional();

// ---------- devices ----------

export const devicesListQuerySchema = z.object({
  group: z.union([uuidSchema, z.literal('none')]).optional(),
  tag: z.string().min(1).max(40).optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  online: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  q: z.string().min(1).max(80).optional(),
  limit: pageLimit,
  cursor,
});

/** `SessionSummary` (GET /devices/:id `recentSessions`). */
export const sessionSummarySchema = z.object({
  id: uuidSchema,
  state: z.enum(SESSION_STATES),
  unattended: z.boolean().nullable(),
  /** Sections 6.2 / 13.2, as on the REST `Session`: the policy in force when this session opened, and who authorised it. */
  policySnapshot: unattendedPolicySchema.nullable().optional(),
  approvedBy: z.enum(APPROVED_BY).nullable().optional(),
  assist: userRefSchema,
  knockedAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  endedAt: isoTimestampSchema.nullable(),
  endReason: z.enum(SESSION_END_REASONS).nullable(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const deviceDetailSchema = deviceSchema.extend({
  group: z.object({ id: uuidSchema, name: z.string() }).nullable(),
  policy: unattendedPolicySchema,
  amt: amtInventorySchema.nullable(),
  recentSessions: z.array(sessionSummarySchema),
});
export type DeviceDetail = z.infer<typeof deviceDetailSchema>;

export const devicesPageSchema = z.object({ items: z.array(deviceSchema), nextCursor: z.string().nullable() });

export const devicePatchSchema = z.strictObject({
  name: name80.optional(),
  groupId: uuidSchema.nullable().optional(),
  tags: deviceTagsSchema.optional(),
  unattendedPolicy: unattendedPolicyPatchSchema.nullable().optional(),
  notifyEmail: emailSchema.nullable().optional(),
});
export type DevicePatch = z.output<typeof devicePatchSchema>;

/** `POST /devices/:id/sessions` (section 3.5): `reason` is required when `unattended`. */
export const deviceSessionRequestSchema = z
  .strictObject({
    reason: reason.optional(),
    unattended: z.boolean(),
    monitors: z
      .array(z.number().int().min(1).max(LIMITS.monitorsMax))
      .min(1)
      .max(LIMITS.monitorsMax)
      .refine((a) => new Set(a).size === a.length, 'unique')
      .optional(),
  })
  .refine((b) => !b.unattended || b.reason !== undefined, { message: 'an unattended session needs a reason', path: ['reason'] });
export type DeviceSessionRequest = z.output<typeof deviceSessionRequestSchema>;
export const deviceSessionReplySchema = z.object({ sessionId: uuidSchema });

/** `POST /devices/:id/deregister` (section 7.2), signed with the identity key (domain `ia-dereg-v1`). */
export const deviceDeregisterSchema = z.strictObject({
  ts: z.number().int().nonnegative(),
  nonce: b64u16Schema,
  sig: b64u64Schema,
});

export const tamperAcknowledgeSchema = z.strictObject({
  note: z
    .string()
    .max(5000)
    .transform((s) => sanitiseText(s, 500))
    .optional(),
});

// ---------- AMT (section 8.4) ----------

export const amtSolRequestSchema = z.strictObject({ reason });
export const amtSolReplySchema = z.object({ solId: uuidSchema, via: uuidSchema });
export const amtBootRequestSchema = z.strictObject({ target: z.enum(AMT_BOOT_TARGETS), reason });
export const amtBootReplySchema = z.object({ cmdId: uuidSchema, via: uuidSchema });

// ---------- actions (section 9) ----------

export const deviceActionQueuedReplySchema = z.object({ actionId: uuidSchema, state: z.enum(['queued', 'dispatched']) });
export const deviceActionsListQuerySchema = z.object({ state: z.enum(DEVICE_ACTION_STATES).optional(), limit: pageLimit, cursor });
export const deviceActionsPageSchema = z.object({ items: z.array(deviceActionSchema), nextCursor: z.string().nullable() });

// ---------- groups (section 7.2) ----------

export const deviceGroupSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  defaultPolicy: unattendedPolicyPatchSchema,
  defaultTags: z.array(z.string()),
  notifyEmail: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type DeviceGroup = z.infer<typeof deviceGroupSchema>;

export const deviceGroupCreateSchema = z.strictObject({
  name: name80,
  description: z
    .string()
    .max(5000)
    .transform((s) => sanitiseText(s, 500))
    .nullable()
    .optional(),
  defaultPolicy: unattendedPolicyPatchSchema.optional(),
  defaultTags: deviceTagsSchema.optional(),
  notifyEmail: emailSchema.nullable().optional(),
});
export const deviceGroupPatchSchema = deviceGroupCreateSchema.partial();

export const userDeviceGroupsSchema = z.strictObject({
  groupIds: z
    .array(uuidSchema)
    .max(LIMITS.deviceGroupsPerOrgMax)
    .transform((a) => [...new Set(a)])
    .nullable(),
});

// ---------- org policies (section 7.2) ----------

export const fleetPolicySchema = z.object({ fleetScopingEnabled: z.boolean(), wakerMeshEnabled: z.boolean() });
export const fleetPolicyPatchSchema = z.strictObject({
  fleetScopingEnabled: z.boolean().optional(),
  wakerMeshEnabled: z.boolean().optional(),
});
/** `PATCH /orgs/current/policy/unattended`: the full org default `UnattendedPolicy`. */
export const unattendedPolicyBodySchema = unattendedPolicySchema;

// ---------- enrollment config (section 7.2, 12.3) ----------

export const enrollConfigQuerySchema = z.object({ tokenId: uuidSchema, groupId: uuidSchema.optional() });
export const enrollConfigReplySchema = z.object({ iaconfig: z.string() });
