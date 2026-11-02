/** Phase F org erasure (docs/specs/phase-f-contracts.md sections 5.1-5.6, 13.2): org_erasure. */
import { sql } from 'drizzle-orm';
import { boolean, char, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { erasureStateEnum } from './enums.js';
import { createdAt, org, tstz, updatedAt, user } from './org.js';

/** One row per attempt; at most one open (`pending_confirmation` .. `executing`) per org. */
export const orgErasure = pgTable(
  'org_erasure',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    state: erasureStateEnum('state').notNull(),
    /** The single-admin path (rule 5.2f). */
    solo: boolean('solo').notNull().default(false),
    /** `sha256Hex` of the solo confirmation token; single use, 24 h. */
    confirmTokenHash: char('confirm_token_hash', { length: 64 }),
    confirmExpiresAt: tstz('confirm_expires_at'),
    /** The requester's typed reason; scrubbed at step 5, never chained. */
    reason: text('reason'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => user.id),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    approvedBy: uuid('approved_by').references(() => user.id),
    approvedAt: tstz('approved_at'),
    coolingOffUntil: tstz('cooling_off_until'),
    cancelledBy: uuid('cancelled_by').references(() => user.id),
    cancelledAt: tstz('cancelled_at'),
    executedAt: tstz('executed_at'),
    completedAt: tstz('completed_at'),
    /** Step name -> ISO time; `carry` holds the sealed step-1 values (section 5.3). */
    progress: jsonb('progress').$type<Record<string, unknown>>().notNull().default({}),
    counts: jsonb('counts').$type<Record<string, unknown>>(),
    certificate: jsonb('certificate').$type<Record<string, unknown>>(),
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('org_erasure_org_id_idx').on(t.orgId),
    uniqueIndex('org_erasure_open_unique')
      .on(t.orgId)
      .where(sql`state in ('pending_confirmation', 'pending_approval', 'cooling_off', 'executing')`),
    index('org_erasure_due_idx').on(t.state, t.coolingOffUntil),
  ],
);
