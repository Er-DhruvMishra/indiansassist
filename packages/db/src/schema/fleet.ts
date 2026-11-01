/**
 * Phase D fleet tables (docs/specs/phase-d-contracts.md sections 8, 9.2, 13.2, migration 0007_phase_d): the device
 * action queue, wake attempts and AMT Serial-over-LAN sessions. Device rows themselves live in token.ts.
 */
import { char, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { deviceActionKindEnum, deviceActionStateEnum, wakeMethodEnum, wakeStateEnum } from './enums.js';
import { createdAt, org, tstz, updatedAt, user } from './org.js';
import { device } from './token.js';

/** Rule 9.2: actions queued for a device (dispatched at once when online, delivered at next check-in otherwise). */
export const deviceAction = pgTable(
  'device_action',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => device.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    kind: deviceActionKindEnum('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    state: deviceActionStateEnum('state').notNull().default('queued'),
    reason: text('reason'),
    /** `policy` | `local_user` | `auto_after_timeout`, null until it runs. */
    approvedBy: text('approved_by'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    expiresAt: tstz('expires_at').notNull(),
    dispatchedAt: tstz('dispatched_at'),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('device_action_org_id_idx').on(t.orgId),
    index('device_action_device_state_idx').on(t.deviceId, t.state),
    index('device_action_expires_idx').on(t.expiresAt),
  ],
);

/** Section 8.1: one `POST /devices/:id/wake`. */
export const wakeAttempt = pgTable(
  'wake_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => device.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    method: wakeMethodEnum('method').notNull(),
    /** deviceId of the waker or AMT proxy. */
    via: text('via'),
    state: wakeStateEnum('state').notNull().default('pending'),
    cause: text('cause'),
    reason: text('reason'),
    createdAt: createdAt(),
    confirmedAt: tstz('confirmed_at'),
  },
  (t) => [index('wake_attempt_org_id_idx').on(t.orgId), index('wake_attempt_device_state_idx').on(t.deviceId, t.state)],
);

/** Rule 8.4d: an out-of-band AMT SOL console session. */
export const amtSol = pgTable(
  'amt_sol',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => device.id),
    openedBy: uuid('opened_by')
      .notNull()
      .references(() => user.id),
    viaDeviceId: uuid('via_device_id').notNull(),
    reason: text('reason').notNull(),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    closedAt: tstz('closed_at'),
    transcriptRef: text('transcript_ref'),
    transcriptSha256: char('transcript_sha256', { length: 64 }),
  },
  (t) => [index('amt_sol_org_id_idx').on(t.orgId), index('amt_sol_device_idx').on(t.deviceId)],
);
