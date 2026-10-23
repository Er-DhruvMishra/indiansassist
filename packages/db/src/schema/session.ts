/** Live support sessions and their participants (contracts section 4.2: session, session_participant). */
import { boolean, char, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import {
  consentStateEnum,
  packageTierEnum,
  participantRoleEnum,
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('session_org_created_idx').on(t.orgId, t.createdAt.desc()),
    index('session_token_id_idx').on(t.tokenId),
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
