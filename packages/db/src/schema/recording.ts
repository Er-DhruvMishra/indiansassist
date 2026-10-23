/** Recordings and the integration placeholder (contracts section 4.2: recording, integration). */
import { bigint, boolean, char, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { auditEntry } from './audit.js';
import { integrationTypeEnum, recordingStatusEnum, regionEnum } from './enums.js';
import { createdAt, org, tstz, updatedAt, user } from './org.js';
import { session } from './session.js';

export const recording = pgTable(
  'recording',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    sessionId: uuid('session_id')
      .notNull()
      .unique('recording_session_id_unique')
      .references(() => session.id),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => user.id),
    status: recordingStatusEnum('status').notNull().default('uploading'),
    storageKey: text('storage_key').notNull().unique('recording_storage_key_unique'),
    mime: text('mime').notNull().default('video/webm'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    sha256: char('sha256', { length: 64 }),
    durationMs: integer('duration_ms'),
    chainedInto: uuid('chained_into').references(() => auditEntry.id),
    uploadId: text('upload_id'),
    uploadExpiresAt: tstz('upload_expires_at'),
    region: regionEnum('region').notNull(),
    createdAt: createdAt(),
    storedAt: tstz('stored_at'),
    /** Phase B Y26: the object was removed from storage; the row stays (the chain references it). */
    deletedAt: tstz('deleted_at'),
    deletedBy: uuid('deleted_by').references(() => user.id),
  },
  (t) => [index('recording_org_id_idx').on(t.orgId)],
);

export const integration = pgTable(
  'integration',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    type: integrationTypeEnum('type').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('integration_org_type_unique').on(t.orgId, t.type)],
);
