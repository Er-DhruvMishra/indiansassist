/**
 * Phase D wake on LAN and AMT power-on (docs/specs/phase-d-contracts.md section 8.1): the `POST /devices/:id/wake`
 * body and reply and the `wake_attempt` wire object.
 */
import { z } from 'zod';
import { LIMITS, WAKE_FAIL_CAUSES, WAKE_METHODS, WAKE_STATES } from '../enums.js';
import { sanitiseText } from '../audit/sanitise.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid');

export const wakeRequestSchema = z.strictObject({
  method: z.enum(WAKE_METHODS).default('auto'),
  reason: z
    .string()
    .max(5000)
    .transform((s) => sanitiseText(s, LIMITS.reasonMax))
    .optional(),
});
export type WakeRequest = z.output<typeof wakeRequestSchema>;

/** `202 { wakeId, method, via }`: `method` is the resolved path (`wol` | `amt`), `via` the waker / AMT proxy or null. */
export const wakeReplySchema = z.strictObject({
  wakeId: uuid,
  method: z.enum(WAKE_METHODS),
  via: uuid.nullable(),
});
export type WakeReply = z.infer<typeof wakeReplySchema>;

export const wakeAttemptSchema = z.object({
  id: uuid,
  deviceId: uuid,
  method: z.enum(WAKE_METHODS),
  via: uuid.nullable(),
  state: z.enum(WAKE_STATES),
  cause: z.enum(WAKE_FAIL_CAUSES).nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
});
export type WakeAttempt = z.infer<typeof wakeAttemptSchema>;
