/**
 * Phase A.2 audit actions (docs/specs/phase-a2-recorder.md section 6): the server recorder's start / stop entries,
 * the `recording.stored` / `recording.failed` shapes with the optional `source: 'server'`, and the recorder actor.
 * Every schema is strict; strings are sanitised with the Phase A section 5.3 rules before hashing.
 */
import { z } from 'zod';
import { RECORDER_ID_RE, RECORDER_STOP_REASONS } from '../enums.js';
import { sanitiseText, SANITISE_LIMITS } from './sanitise.js';

const text = (limit: number = SANITISE_LIMITS.default) => z.string().transform((s) => sanitiseText(s, limit));
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recorderId = z.string().regex(RECORDER_ID_RE, 'invalid recorderId');
/** Present only on server recordings, so Phase A entries keep their exact shape. */
const source = z.literal('server').optional();

export const A2_AUDIT_ACTIONS = ['recording.server_started', 'recording.server_stopped'] as const;
export type A2AuditAction = (typeof A2_AUDIT_ACTIONS)[number];

export const A2_CHAIN_SCHEMAS = {
  'recording.server_started': z.strictObject({ recorderId, recordingMode: z.enum(['server', 'both']) }),
  'recording.server_stopped': z.strictObject({ recorderId, reason: z.enum(RECORDER_STOP_REASONS) }),
} satisfies Record<A2AuditAction, z.ZodType>;

/** `recording.stored` (Phase A 5.3 plus A.2 `source`). */
export const recordingStoredDataSchema = z.strictObject({
  recordingId: text(),
  sha256: hash,
  bytes: int,
  mime: text(255),
  storageKey: text(),
  source,
});

/** `recording.failed` (Phase A 5.3 plus A.2 `source`). */
export const recordingFailedDataSchema = z.strictObject({
  recordingId: text(),
  error: text(SANITISE_LIMITS.error),
  source,
});

/** Audit actor of the recorder service (section 2 P3). */
export function recorderActor(id: string): { type: 'system'; id: string; label: 'recorder' } {
  return { type: 'system', id: `recorder:${id}`, label: 'recorder' };
}
