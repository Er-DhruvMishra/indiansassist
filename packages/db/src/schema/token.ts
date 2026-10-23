/** Support tokens and the P4 device placeholder (contracts section 4.2: token, device). */
import { sql } from 'drizzle-orm';
import { char, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { deviceStatusEnum, packageTierEnum, regionEnum, tokenStatusEnum, tokenTypeEnum } from './enums.js';
import { createdAt, org, tstz, tstz3, updatedAt, user } from './org.js';

export const token = pgTable(
  'token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    tier: packageTierEnum('tier').notNull(),
    typ: tokenTypeEnum('typ').notNull(),
    status: tokenStatusEnum('status').notNull().default('active'),
    shortCode: char('short_code', { length: 12 }).notNull(),
    label: text('label'),
    region: regionEnum('region').notNull(),
    kid: text('kid').notNull(),
    signature: text('signature').notNull(),
    nonce: text('nonce').notNull(),
    issuedAt: tstz3('issued_at').notNull(),
    expiresAt: tstz3('expires_at').notNull(),
    usedAt: tstz('used_at'),
    revokedAt: tstz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => user.id),
    deniedCount: integer('denied_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('token_org_id_idx').on(t.orgId),
    index('token_created_by_idx').on(t.createdBy),
    index('token_org_status_idx').on(t.orgId, t.status),
    index('token_expires_at_idx').on(t.expiresAt),
    uniqueIndex('token_short_code_active_unique')
      .on(t.shortCode)
      .where(sql`status = 'active'`),
  ],
);

export const device = pgTable(
  'device',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    name: text('name').notNull(),
    publicKey: text('public_key'),
    status: deviceStatusEnum('status').notNull().default('enrolled'),
    groupName: text('group_name'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    enrolledByTokenId: uuid('enrolled_by_token_id').references(() => token.id),
    lastSeenAt: tstz('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('device_org_id_idx').on(t.orgId)],
);
