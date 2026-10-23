/** Mutable per-session file attestations (contracts section 4.2: session_file). Plaintext names live here only. */
import { bigint, char, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { auditEntry } from './audit.js';
import { fileDirectionEnum } from './enums.js';
import { createdAt, updatedAt } from './org.js';
import { session } from './session.js';

export const sessionFile = pgTable(
  'session_file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    direction: fileDirectionEnum('direction').notNull(),
    fileId: integer('file_id').notNull(),
    name: text('name').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    assistSha256: char('assist_sha256', { length: 64 }),
    deskSha256: char('desk_sha256', { length: 64 }),
    assistEntryId: uuid('assist_entry_id').references(() => auditEntry.id),
    deskEntryId: uuid('desk_entry_id').references(() => auditEntry.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('session_file_session_direction_file_unique').on(t.sessionId, t.direction, t.fileId)],
);
