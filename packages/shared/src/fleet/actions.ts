/**
 * Phase D device actions and the offline action queue (docs/specs/phase-d-contracts.md section 9, 13.1a): per-kind
 * payloads, the `POST /devices/:id/actions` body with its reason-required rules, the reported `result` object and the
 * `DeviceAction` wire object (REST and the `device.action` push; `secrets` never appears in REST).
 */
import { z } from 'zod';
import { APPROVED_BY, DEVICE_ACTION_KINDS, DEVICE_ACTION_STATES, LIMITS, PLAYBOOK_RAN_AS } from '../enums.js';
import { sanitiseText } from '../audit/sanitise.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lower-case hex chars');
const fileRef = z.string().min(1).max(2048).regex(/^https?:\/\//, 'an http(s) presigned URL');
const fileName = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .refine((n) => !/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(n), 'a bare file name');

/** Rule 9.3: validated exactly as C section 8 (the api re-checks the args against the pinned catalogue entry). */
export const playbookRunActionSchema = z.strictObject({
  playbookId: uuid,
  args: z.record(z.string().max(32), z.union([z.string().max(16_000), z.number(), z.boolean()])).default({}),
  requiresElevation: z.boolean(),
});
/** Rule 9.4: never auto-executed. */
export const filePushActionSchema = z.strictObject({
  fileRef,
  name: fileName,
  bytes: z.number().int().nonnegative().max(LIMITS.fileMaxBytesNative),
  sha256: hex64,
});
/** Rule 9.5: a named (non-default) printer is privileged and needs a reason. */
export const printActionSchema = z.strictObject({ fileRef, name: fileName, printer: z.string().min(1).max(128).optional() });
/** Rule 9.6: a notification; never executes anything. */
export const messageActionSchema = z.strictObject({ title: z.string().min(1).max(100), body: z.string().min(1).max(1000) });

export const DEVICE_ACTION_PAYLOAD_SCHEMAS = {
  playbook_run: playbookRunActionSchema,
  file_push: filePushActionSchema,
  print: printActionSchema,
  message: messageActionSchema,
} as const;

const reason = z
  .string()
  .max(5000)
  .transform((s) => sanitiseText(s, LIMITS.reasonMax).trim())
  .refine((s) => s.length >= 1, 'reason is 1..500 characters');

/**
 * `POST /api/v1/devices/:id/actions` body. `reason` is required for a `playbook_run` with `requiresElevation` (and,
 * checked by the api against the catalogue, one declaring `vaultRefs`) and for a `print` naming a `printer`.
 */
export const deviceActionRequestSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('playbook_run'), payload: playbookRunActionSchema, reason: reason.optional() }),
    z.strictObject({ kind: z.literal('file_push'), payload: filePushActionSchema, reason: reason.optional() }),
    z.strictObject({ kind: z.literal('print'), payload: printActionSchema, reason: reason.optional() }),
    z.strictObject({ kind: z.literal('message'), payload: messageActionSchema, reason: reason.optional() }),
  ])
  .superRefine((v, ctx) => {
    if (v.reason !== undefined) return;
    if (v.kind === 'playbook_run' && v.payload.requiresElevation)
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'a privileged playbook run needs a reason' });
    if (v.kind === 'print' && v.payload.printer !== undefined)
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'printing to a named printer needs a reason' });
  });
export type DeviceActionRequest = z.output<typeof deviceActionRequestSchema>;

/** Rule 9.9: whether an action is privileged (needs `allowPrivileged`). `vaultRefs` comes from the catalogue entry. */
export function isPrivilegedAction(a: { kind: string; payload: unknown }, opts: { vaultRefs?: number } = {}): boolean {
  const p = a.payload as { requiresElevation?: unknown; printer?: unknown } | null;
  if (a.kind === 'playbook_run') return p?.requiresElevation === true || (opts.vaultRefs ?? 0) > 0;
  if (a.kind === 'print') return typeof p?.printer === 'string';
  return false;
}

/** The `result` object a device reports (rule 9.7); output content of a playbook is never included. */
export const deviceActionResultSchema = z.strictObject({
  exit: z.number().int().optional(),
  ranAs: z.enum(PLAYBOOK_RAN_AS).optional(),
  pages: z.number().int().nonnegative().optional(),
  path: z.string().max(1024).optional(),
  error: z.string().max(200).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type DeviceActionResult = z.infer<typeof deviceActionResultSchema>;

/** `DeviceAction` (REST, section 13.1a). */
export const deviceActionSchema = z.object({
  id: uuid,
  deviceId: uuid,
  kind: z.enum(DEVICE_ACTION_KINDS),
  payload: z.record(z.string(), z.unknown()),
  state: z.enum(DEVICE_ACTION_STATES),
  reason: z.string().nullable(),
  approvedBy: z.enum(APPROVED_BY).nullable(),
  result: deviceActionResultSchema.nullable(),
  createdBy: z.object({ id: uuid, name: z.string() }),
  createdAt: z.string(),
  dispatchedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type DeviceAction = z.infer<typeof deviceActionSchema>;
