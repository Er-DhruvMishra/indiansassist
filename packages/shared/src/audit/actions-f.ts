/**
 * Phase F audit actions (docs/specs/phase-f-contracts.md section 13.3): the chain shapes of every new action
 * (strict, strings sanitised before hashing) and the one actor each is written by. Emails appear only as
 * `emailHash`; no token, reset link, mail body, camera code, camera frame, snapshot bytes or erasure reason is ever
 * in a chain `data` object. `session_id` is set on every `camera.*` entry and null on the others.
 */
import { z } from 'zod';
import { CAMERA_FACINGS, CAMERA_STOP_REASONS, RESET_OUTCOMES } from '../enums.js';
import { sanitiseText } from './sanitise.js';

const id = z.string().transform((s) => sanitiseText(s, 100));
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
const iso = z.string().transform((s) => sanitiseText(s, 40));
const dim = z.number().int().min(1).max(8192);

/** Chain `data` of the Phase F actions (merged into AUDIT_ACTIONS / auditDataSchema by actions.ts). */
export const F_CHAIN_SCHEMAS = {
  // ---------- mail (section 4) ----------
  'user.invite_mailed': z.strictObject({
    userId: id,
    delivered: z.boolean(),
    cause: z.enum(['no_mailer', 'send_failed']).nullable(),
  }),
  'user.invite_resent': z.strictObject({ userId: id }),
  'auth.password_reset_requested': z.strictObject({ userId: id, outcome: z.enum(RESET_OUTCOMES) }),
  'auth.password_reset': z.strictObject({ userId: id, revokedSessions: int }),
  // ---------- erasure (section 5) ----------
  'org.erasure_requested': z.strictObject({ erasureId: id, solo: z.boolean() }),
  'org.erasure_confirmed': z.strictObject({ erasureId: id, coolingOffUntil: iso }),
  'org.erasure_approved': z.strictObject({ erasureId: id, coolingOffUntil: iso }),
  // `pending_confirmation` added to the section 13.3 values: section 5.1 lets a solo erasure be cancelled there too.
  'org.erasure_cancelled': z.strictObject({
    erasureId: id,
    fromState: z.enum(['pending_confirmation', 'pending_approval', 'cooling_off']),
  }),
  'org.erasure_expired': z.strictObject({ erasureId: id }),
  'org.erasure_started': z.strictObject({ erasureId: id }),
  'org.erased': z.strictObject({
    erasureId: id,
    entriesBefore: int,
    counts: z
      .record(z.string().transform((s) => sanitiseText(s, 40)), int)
      .refine((c) => Object.keys(c).length <= 40, 'at most 40 counts'),
  }),
  // ---------- camera (section 6) ----------
  'camera.link_created': z.strictObject({ cameraId: id, expiresAt: iso }),
  'camera.link_revoked': z.strictObject({ cameraId: id }),
  'camera.started': z.strictObject({ cameraId: id, width: dim, height: dim, facing: z.enum(CAMERA_FACINGS) }),
  'camera.ended': z.strictObject({ cameraId: id, by: z.enum(CAMERA_STOP_REASONS), durationMs: int.nullable() }),
  'camera.snapshot': z.strictObject({ cameraId: id, sha256: hash, width: dim, height: dim }),
} as const;

export const F_AUDIT_ACTIONS = Object.keys(F_CHAIN_SCHEMAS) as (keyof typeof F_CHAIN_SCHEMAS)[];
export type FAuditAction = keyof typeof F_CHAIN_SCHEMAS;

/**
 * Section 13.3: exactly one actor per action. `camera.started` is written as the Desk (`deskActor(session.desk_ref)`):
 * the phone is reached only through the Desk person.
 */
export const F_ACTION_ACTORS: Record<FAuditAction, 'user' | 'system' | 'desk'> = {
  'user.invite_mailed': 'user',
  'user.invite_resent': 'user',
  'auth.password_reset_requested': 'system',
  'auth.password_reset': 'user',
  'org.erasure_requested': 'user',
  'org.erasure_confirmed': 'user',
  'org.erasure_approved': 'user',
  'org.erasure_cancelled': 'user',
  'org.erasure_expired': 'system',
  'org.erasure_started': 'system',
  'org.erased': 'system',
  'camera.link_created': 'user',
  'camera.link_revoked': 'user',
  'camera.started': 'desk',
  'camera.ended': 'system',
  'camera.snapshot': 'user',
};

/** Section 13.3: the entries whose `session_id` is set (every `camera.*`); the others have none. */
export function fActionHasSession(action: FAuditAction): boolean {
  return action.startsWith('camera.');
}
