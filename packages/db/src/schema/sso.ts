/** Phase E SSO tables (docs/specs/phase-e-contracts.md sections 3.2, 3.6, 13.2): sso_domain, sso_identity. */
import { sql } from 'drizzle-orm';
import { char, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ssoDomainStatusEnum, ssoProtocolEnum } from './enums.js';
import { createdAt, org, tstz, user } from './org.js';

/** An email domain claim of one org (rules 3.2a-3.2e); unique per region among `verified` rows. */
export const ssoDomain = pgTable(
  'sso_domain',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    /** Lower-case ASCII (IDNA-to-ASCII), `normaliseDomain`. */
    domain: text('domain').notNull(),
    status: ssoDomainStatusEnum('status').notNull().default('pending'),
    /** 32 lower-case hex from 16 CSPRNG bytes. */
    verifyToken: char('verify_token', { length: 32 }).notNull(),
    verifiedAt: tstz('verified_at'),
    lastCheckedAt: tstz('last_checked_at'),
    /** Consecutive re-check misses (three set `lapsed`, rule 3.2d). */
    misses: integer('misses').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('sso_domain_org_id_idx').on(t.orgId),
    unique('sso_domain_org_domain_unique').on(t.orgId, t.domain),
    uniqueIndex('sso_domain_verified_unique').on(t.domain).where(sql`status = 'verified'`),
  ],
);

/** A linked IdP identity (section 3.6): `(org, protocol, issuer, subject)` resolves to one user. */
export const ssoIdentity = pgTable(
  'sso_identity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    protocol: ssoProtocolEnum('protocol').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    linkedAt: tstz('linked_at').notNull().defaultNow(),
    lastLoginAt: tstz('last_login_at'),
  },
  (t) => [
    index('sso_identity_user_id_idx').on(t.userId),
    unique('sso_identity_org_protocol_issuer_subject_unique').on(t.orgId, t.protocol, t.issuer, t.subject),
  ],
);
