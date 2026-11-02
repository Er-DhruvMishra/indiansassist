/** Phase F password reset (docs/specs/phase-f-contracts.md sections 4.3, 13.2): password_reset. */
import { boolean, char, index, pgTable, uuid } from 'drizzle-orm/pg-core';
import { createdAt, tstz, user } from './org.js';

/** A single-use reset token, stored only as `sha256Hex(token)`; superseded rows are marked used (rule 4.3c). */
export const passwordReset = pgTable(
  'password_reset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique('password_reset_token_hash_unique'),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    superseded: boolean('superseded').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('password_reset_user_id_idx').on(t.userId)],
);
