/** Phase E AI session summaries (docs/specs/phase-e-contracts.md sections 5.1, 5.8, 13.2): session_summary. */
import { sql } from 'drizzle-orm';
import { boolean, char, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { aiProviderEnum, summaryStateEnum, summaryTriggerEnum } from './enums.js';
import { createdAt, org, tstz, user } from './org.js';
import { session } from './session.js';

/** One version of a session's summary; versions are never deleted or rewritten once terminal (rule 5.8f). */
export const sessionSummary = pgTable(
  'session_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id),
    version: integer('version').notNull(),
    state: summaryStateEnum('state').notNull(),
    trigger: summaryTriggerEnum('trigger').notNull(),
    provider: aiProviderEnum('provider').notNull(),
    model: text('model').notNull(),
    servedModel: text('served_model'),
    inferenceGeo: text('inference_geo'),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    transcriptIncluded: boolean('transcript_included').notNull().default(false),
    normalised: boolean('normalised').notNull().default(false),
    inputSha256: char('input_sha256', { length: 64 }),
    /** `SessionSummaryOutput` (section 5.5). */
    output: jsonb('output').$type<Record<string, unknown>>(),
    outputSha256: char('output_sha256', { length: 64 }),
    redactionCounts: jsonb('redaction_counts').$type<Record<string, number>>().notNull().default({}),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    /** A SUMMARY_FAIL_CAUSES value when failed. */
    cause: text('cause'),
    detail: text('detail'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    baseVersion: integer('base_version'),
    /** null = automatic (session end). */
    createdBy: uuid('created_by').references(() => user.id),
    editedBy: uuid('edited_by').references(() => user.id),
    createdAt: createdAt(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    index('session_summary_org_id_idx').on(t.orgId),
    unique('session_summary_session_version_unique').on(t.sessionId, t.version),
    index('session_summary_due_idx').on(t.nextAttemptAt).where(sql`state = 'pending'`),
  ],
);
