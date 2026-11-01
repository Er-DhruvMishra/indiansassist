/**
 * Phase D tamper events (docs/specs/phase-d-contracts.md section 10): a device-recorded event, signed with the
 * identity key (domain `ia-tamper-v1` over the canonical JSON of the event without `sig`).
 */
import { z } from 'zod';
import { TAMPER_CAUSES } from '../enums.js';

export const tamperEventSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid'),
  cause: z.enum(TAMPER_CAUSES),
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ISO 8601 UTC with milliseconds'),
  detail: z.string().max(500).optional(),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'base64url Ed25519 signature'),
});
export type TamperEvent = z.infer<typeof tamperEventSchema>;
