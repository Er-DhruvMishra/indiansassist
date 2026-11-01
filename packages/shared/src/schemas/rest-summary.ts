/** REST schemas of the AI summary routes (docs/specs/phase-e-contracts.md section 5.9). */
import { z } from 'zod';
import { AI_PROVIDERS, SUMMARY_FAIL_CAUSES, SUMMARY_STATES, SUMMARY_TRIGGERS } from '../enums.js';
import { redactionCountsSchema } from '../enterprise/redact.js';
import { sessionSummaryOutputSchema } from '../enterprise/summary.js';
import { hex64Schema, isoTimestampSchema, uuidSchema } from './common.js';

const userRef = z.strictObject({ id: uuidSchema, name: z.string() });

export const sessionSummaryMetaSchema = z.strictObject({
  id: uuidSchema,
  sessionId: uuidSchema,
  version: z.number().int().min(1),
  state: z.enum(SUMMARY_STATES),
  trigger: z.enum(SUMMARY_TRIGGERS),
  provider: z.enum(AI_PROVIDERS),
  model: z.string(),
  servedModel: z.string().nullable(),
  inferenceGeo: z.string().nullable(),
  fallbackUsed: z.boolean(),
  transcriptIncluded: z.boolean(),
  normalised: z.boolean(),
  redactions: redactionCountsSchema,
  sha256: hex64Schema.nullable(),
  inputSha256: hex64Schema.nullable(),
  cause: z.enum(SUMMARY_FAIL_CAUSES).nullable(),
  attempts: z.number().int().nonnegative(),
  createdBy: userRef.nullable(),
  editedBy: userRef.nullable(),
  createdAt: isoTimestampSchema,
  completedAt: isoTimestampSchema.nullable(),
});
export type SessionSummaryMeta = z.infer<typeof sessionSummaryMetaSchema>;

/**
 * The wire `SessionSummary` of section 5.9 (meta plus output). Named `aiSessionSummarySchema` / `AiSessionSummary`
 * because Phase D already exports `sessionSummarySchema` / `SessionSummary` (a device's recent session, rest-fleet.ts).
 */
export const aiSessionSummarySchema = sessionSummaryMetaSchema.extend({ output: sessionSummaryOutputSchema.nullable() });
export type AiSessionSummary = z.infer<typeof aiSessionSummarySchema>;

/** `GET /sessions/:id/summary`. */
export const sessionSummaryListSchema = z.strictObject({
  latest: aiSessionSummarySchema.nullable(),
  versions: z.array(sessionSummaryMetaSchema),
});

/** `POST /sessions/:id/summary` reply (`202`, pending). */
export const aiSessionSummaryReplySchema = z.strictObject({ summary: aiSessionSummarySchema });

/** `PUT /sessions/:id/summary`. */
export const summaryEditRequestSchema = z.strictObject({
  baseVersion: z.number().int().min(1),
  output: sessionSummaryOutputSchema,
});

/** `POST /sessions/:id/summary-input` reply (`202`). */
export const summaryInputReplySchema = z.strictObject({ sha256: hex64Schema, redactions: redactionCountsSchema });
