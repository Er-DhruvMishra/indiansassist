/**
 * Phase C tables (docs/specs/phase-c-contracts.md sections 7.2, 8.1, 13.2, migration 0005_phase_c): the org playbook
 * catalogue, the per-session run log (pairs the console's run_requested with the agent's playbook.run) and the
 * elevation hand-over log (the live single-use value lives in the presence store; the session row carries the
 * outstanding hash for the sweeper).
 */
import { sql } from 'drizzle-orm';
import { boolean, char, check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { playbookInterpreterEnum } from './enums.js';
import { createdAt, org, tstz, updatedAt, user } from './org.js';
import { session } from './session.js';

export const playbook = pgTable(
  'playbook',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    interpreter: playbookInterpreterEnum('interpreter').notNull(),
    body: text('body').notNull(),
    /** sha256 of the UTF-8 body, always computed by the server. */
    bodySha256: char('body_sha256', { length: 64 }).notNull(),
    requiresElevation: boolean('requires_elevation').notNull().default(false),
    /** `PlaybookParam[]` (args schema), at most 16. */
    parameters: jsonb('parameters').$type<unknown[]>().notNull().default([]),
    timeoutSec: integer('timeout_sec').notNull().default(120),
    enabled: boolean('enabled').notNull().default(true),
    /** Phase D rule 9.8: `[{ env, path }]` (<= 8); such a playbook runs only as a device action. */
    vaultRefs: jsonb('vault_refs').$type<{ env: string; path: string }[]>(),
    createdBy: uuid('created_by').references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('playbook_org_name_unique').on(t.orgId, t.name),
    index('playbook_org_updated_idx').on(t.orgId, t.updatedAt.desc()),
    check('playbook_timeout_range', sql`timeout_sec between 1 and 900`),
    check('playbook_body_size', sql`octet_length(body) between 1 and 65536`),
  ],
);

export const playbookRun = pgTable(
  'playbook_run',
  {
    /** The server-minted `runId` (32 lower-case hex). */
    runId: char('run_id', { length: 32 }).primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    /** No foreign key: a deleted playbook keeps its runs (the chain is the record). */
    playbookId: uuid('playbook_id').notNull(),
    bodySha256: char('body_sha256', { length: 64 }).notNull(),
    opId: char('op_id', { length: 16 }).notNull(),
    requestedBy: uuid('requested_by').references(() => user.id),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    /** Filled from the agent's `playbook.run` attestation. */
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms'),
    ranAs: text('ran_as'),
    error: text('error'),
    endedAt: tstz('ended_at'),
  },
  (t) => [index('playbook_run_session_idx').on(t.sessionId), index('playbook_run_org_requested_idx').on(t.orgId, t.requestedAt.desc())],
);

export const elevationHandover = pgTable(
  'elevation_handover',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    /** sha256 of the hand-over value (the value itself is never stored). */
    tokenHash: char('token_hash', { length: 64 }).notNull().unique('elevation_handover_token_hash_unique'),
    opId: char('op_id', { length: 16 }).notNull(),
    expiresAt: tstz('expires_at').notNull(),
    claimed: boolean('claimed').notNull().default(false),
    claimedAt: tstz('claimed_at'),
    /** `claimed`, `expired`, `rejected` or `superseded` once settled. */
    outcome: text('outcome'),
    createdAt: createdAt(),
  },
  (t) => [index('elevation_handover_session_idx').on(t.sessionId), index('elevation_handover_org_created_idx').on(t.orgId, t.createdAt.desc())],
);
