/** Phase E ticket pushes (docs/specs/phase-e-contracts.md sections 4.4, 13.2): ticket_push. */
import { sql } from 'drizzle-orm';
import { char, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { integrationTypeEnum, ticketPushModeEnum, ticketPushStateEnum } from './enums.js';
import { createdAt, org, tstz, updatedAt, user } from './org.js';
import { integration } from './recording.js';
import { session } from './session.js';
import { sessionSummary } from './summary.js';

/** One attempt-tracked delivery of a ticket or note (rule 4.4a). `content` is region data, never returned whole. */
export const ticketPush = pgTable(
  'ticket_push',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integration.id),
    type: integrationTypeEnum('type').notNull(),
    mode: ticketPushModeEnum('mode').notNull(),
    /** The ticket to append to (`mode: 'append'`). */
    externalIdIn: text('external_id_in'),
    source: text('source').$type<'summary' | 'manual'>().notNull(),
    summaryId: uuid('summary_id').references(() => sessionSummary.id),
    summaryVersion: integer('summary_version'),
    /** The `TicketContent` exactly as sent. */
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    contentSha256: char('content_sha256', { length: 64 }).notNull(),
    state: ticketPushStateEnum('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    manualRetries: integer('manual_retries').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at'),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    /** `TicketFailure` of the last failed attempt. */
    lastFailure: jsonb('last_failure').$type<Record<string, unknown>>(),
    clientPushId: uuid('client_push_id').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    deliveredAt: tstz('delivered_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('ticket_push_org_id_idx').on(t.orgId),
    index('ticket_push_session_id_idx').on(t.sessionId),
    index('ticket_push_due_idx').on(t.nextAttemptAt).where(sql`state = 'retrying'`),
    unique('ticket_push_org_client_push_unique').on(t.orgId, t.clientPushId),
    check('ticket_push_source_check', sql`source in ('summary', 'manual')`),
  ],
);
