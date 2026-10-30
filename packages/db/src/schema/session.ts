/** Live support sessions and their participants (contracts section 4.2: session, session_participant). */
import { sql } from 'drizzle-orm';
import { boolean, char, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  consentLevelEnum,
  consentStateEnum,
  elevationLevelEnum,
  mirrorScopeEnum,
  packageTierEnum,
  participantRoleEnum,
  recordingModeEnum,
  regionEnum,
  sessionEndReasonEnum,
  sessionPathEnum,
  sessionStateEnum,
} from './enums.js';
import { createdAt, org, tstz, updatedAt, user } from './org.js';
import { token } from './token.js';

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => token.id),
    assistUserId: uuid('assist_user_id')
      .notNull()
      .references(() => user.id),
    deskLabel: text('desk_label'),
    deskRef: text('desk_ref').notNull(),
    deskUserAgent: text('desk_user_agent'),
    resumeKeyHash: char('resume_key_hash', { length: 64 }),
    tier: packageTierEnum('tier').notNull(),
    state: sessionStateEnum('state').notNull().default('knocked'),
    consentState: consentStateEnum('consent_state').notNull().default('pending'),
    consentSurface: text('consent_surface'),
    path: sessionPathEnum('path').notNull().default('unknown'),
    region: regionEnum('region').notNull(),
    nodeId: text('node_id').notNull(),
    knockedAt: tstz('knocked_at').notNull().defaultNow(),
    knockExpiresAt: tstz('knock_expires_at'),
    consentDeadlineAt: tstz('consent_deadline_at'),
    acceptedAt: tstz('accepted_at'),
    consentAt: tstz('consent_at'),
    startedAt: tstz('started_at'),
    endedAt: tstz('ended_at'),
    endReason: sessionEndReasonEnum('end_reason'),
    lastStats: jsonb('last_stats').$type<Record<string, unknown>>(),
    recordingStarted: boolean('recording_started').notNull().default(false),
    hashChainTail: char('hash_chain_tail', { length: 64 }),
    // Phase B 11.1: the P2 consent decision and the Desk client object (null for P1 sessions).
    consentLevel: consentLevelEnum('consent_level'),
    consentScope: mirrorScopeEnum('consent_scope'),
    consentBackstage: boolean('consent_backstage'),
    deskClient: jsonb('desk_client').$type<Record<string, unknown>>(),
    /** Phase A.2 M1: the org recording policy snapshotted at accept (null = before A.2, treated as assist_only). */
    recordingMode: recordingModeEnum('recording_mode'),
    /** Phase A.2: set when `recording.server_started` was written. */
    serverRecording: boolean('server_recording').notNull().default(false),
    // Phase C section 13.2: the native consent (monitor count, clipboard switch), the attested integrity level and
    // the one outstanding elevation hand-over (the sweeper reads handover_expires_at, not the TTL store).
    consentMonitors: integer('consent_monitors'),
    consentClipboard: boolean('consent_clipboard'),
    elevation: elevationLevelEnum('elevation'),
    handoverHash: char('handover_hash', { length: 64 }),
    handoverOpid: text('handover_opid'),
    handoverExpiresAt: tstz('handover_expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('session_org_created_idx').on(t.orgId, t.createdAt.desc()),
    index('session_token_id_idx').on(t.tokenId),
    // At most one non-ended session per token (contracts 3.2 / 7.3 `token_busy`), enforced by the database so two
    // concurrent knocks cannot both insert.
    uniqueIndex('session_token_open_unique')
      .on(t.tokenId)
      .where(sql`state <> 'ended'`),
    index('session_assist_user_id_idx').on(t.assistUserId),
    index('session_org_state_idx').on(t.orgId, t.state),
  ],
);

export const sessionParticipant = pgTable(
  'session_participant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    role: participantRoleEnum('role').notNull(),
    userId: uuid('user_id').references(() => user.id),
    label: text('label').notNull(),
    connectionId: text('connection_id').notNull(),
    joinedAt: tstz('joined_at').notNull().defaultNow(),
    leftAt: tstz('left_at'),
  },
  (t) => [index('session_participant_session_id_idx').on(t.sessionId)],
);

/**
 * Phase B 11.1: the plaintext host behind a chain `hostHash`, once per (session, hostHash). Mutable and deletable for
 * erasure (the chain only ever holds the peppered hash), read joined by the session audit view.
 */
export const sessionHost = pgTable(
  'session_host',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    hostHash: char('host_hash', { length: 64 }).notNull(),
    host: text('host').notNull(),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
  },
  (t) => [unique('session_host_session_hash_unique').on(t.sessionId, t.hostHash)],
);
