/**
 * Append-only audit tables (contracts sections 4.2 and 5): audit_entry, audit_checkpoint. The UPDATE / DELETE /
 * TRUNCATE blocking triggers live in the custom migration drizzle/0001_append_only.sql.
 */
import { bigint, boolean, char, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { JsonObject, VerifyFailure } from '@indiansassist/shared';
import { actorTypeEnum, checkpointKindEnum, regionEnum } from './enums.js';
import { createdAt, org, tstz3 } from './org.js';
import { session } from './session.js';

export const auditEntry = pgTable(
  'audit_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    sessionId: uuid('session_id').references(() => session.id),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    reason: text('reason'),
    region: regionEnum('region').notNull(),
    ts: tstz3('ts').notNull(),
    data: jsonb('data').$type<JsonObject>().notNull().default({}),
    prevHash: char('prev_hash', { length: 64 }).notNull(),
    hash: char('hash', { length: 64 }).notNull().unique('audit_entry_hash_unique'),
  },
  (t) => [
    unique('audit_entry_org_seq_unique').on(t.orgId, t.seq),
    index('audit_entry_session_id_idx').on(t.sessionId),
    index('audit_entry_org_action_idx').on(t.orgId, t.action),
  ],
);

export const auditCheckpoint = pgTable(
  'audit_checkpoint',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    kind: checkpointKindEnum('kind').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    tail: char('tail', { length: 64 }).notNull(),
    ts: tstz3('ts').notNull(),
    kid: text('kid').notNull(),
    sig: text('sig').notNull(),
    anchoredEntryId: uuid('anchored_entry_id').references(() => auditEntry.id),
    verifyOk: boolean('verify_ok'),
    verifyChecked: bigint('verify_checked', { mode: 'number' }),
    verifyFailure: jsonb('verify_failure').$type<VerifyFailure>(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_checkpoint_org_seq_idx').on(t.orgId, t.seq.desc())],
);
