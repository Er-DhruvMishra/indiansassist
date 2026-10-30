/**
 * Phase C WebSocket messages (docs/specs/phase-c-contracts.md sections 3.4, 3.6 M5, 4.4, 7.2): the native Desk's
 * clipboard / monitor switches and elevation request, the hand-over reply, `session.handed_over`, and the
 * `agent.stats` frame of `ia.ctrl`. Joined into the unions by signal.ts. The P3 additions to existing messages
 * (`desk.hello`, `desk.consent.native`, ...) live with those messages in signal-messages.ts.
 */
import { z } from 'zod';
import { epochMsSchema, isoTimestampSchema, uuidSchema } from './common.js';
import { ABR_RUNGS, CAPTURE_PATHS, LIMITS, VIDEO_ENCODERS } from '../enums.js';
import { opIdSchema } from '../audit/actions-p2.js';

const envelope = { id: z.string().max(64).optional(), re: z.string().max(64).optional(), ts: epochMsSchema.optional() };
function msg<T extends string, S extends z.ZodRawShape>(t: T, shape: S) {
  return z.object({ t: z.literal(t), ...envelope, ...shape });
}
const sessionId = uuidSchema;
const monitorIdSchema = z.number().int().min(1).max(LIMITS.monitorsMax);
const monitorIdsSchema = z
  .array(monitorIdSchema)
  .min(1)
  .max(LIMITS.monitorsMax)
  .refine((a) => new Set(a).size === a.length, 'monitor ids must be unique');

/** Phase C section 3.4: the Desk's clipboard switch (D->S, `active`, P3 only). */
export const deskConsentClipboardSchema = msg('desk.consent_clipboard', { sessionId, clipboard: z.boolean() });
/** Phase C section 3.6 M5: the consented monitor set (D->S, `active`, P3 only). */
export const deskConsentMonitorsSchema = msg('desk.consent_monitors', { sessionId, monitors: monitorIdsSchema });
/** Phase C section 7.2: the Desk asks for a hand-over token after the user allowed elevation. */
export const deskElevationSchema = msg('desk.elevation', { sessionId, opId: opIdSchema });

/** Phase C section 7.2: reply to `desk.elevation` with the one-time hand-over value. */
export const elevationHandoverSchema = msg('elevation.handover', {
  sessionId,
  handover: z.string().min(1).max(256),
  expiresAt: isoTimestampSchema,
});
/** Phase C section 7.2: the old Desk socket was replaced by the elevated instance (then close 4411). */
export const sessionHandedOverSchema = msg('session.handed_over', { sessionId });

/** Phase C section 4.4: `agent.stats` on the encrypted `ia.ctrl` every 2 s. */
export const agentStatsSchema = z.strictObject({
  t: z.literal('agent.stats'),
  encoder: z.enum(VIDEO_ENCODERS),
  hwEncoder: z.boolean(),
  capturePath: z.enum(CAPTURE_PATHS),
  rung: z.enum(ABR_RUNGS).nullable(),
  floorMode: z.boolean(),
  targetKbps: z.number().int().nonnegative(),
  sentKbps: z.number().int().nonnegative(),
  recorderKbps: z.number().int().nonnegative().nullable(),
  captureFps: z.number().nonnegative(),
  sentFps: z.number().nonnegative(),
  encodeMs: z.number().nonnegative().nullable(),
  monitors: z
    .array(
      z.strictObject({
        id: monitorIdSchema,
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        fps: z.number().nonnegative(),
      }),
    )
    .max(LIMITS.monitorsMax),
  cpuPercent: z.number().nonnegative().nullable(),
  ts: epochMsSchema,
});
export type AgentStats = z.infer<typeof agentStatsSchema>;
