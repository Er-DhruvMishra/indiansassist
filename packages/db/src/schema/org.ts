/** Tenancy and identity tables (contracts section 4.2): org, user, technician_seat, auth_session, login_attempt. */
import { sql } from 'drizzle-orm';
import { boolean, char, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { packageTierEnum, recordingModeEnum, regionEnum, userRoleEnum, userStatusEnum } from './enums.js';

/** `timestamp(..., { withTimezone: true, mode: 'date' })` as section 4 requires. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** Millisecond precision variant (`audit_entry.ts`, `audit_checkpoint.ts`, token iat / exp). */
export const tstz3 = (name: string) => timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });
export const createdAt = () => tstz('created_at').notNull().defaultNow();
export const updatedAt = () =>
  tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export type OrgBranding = {
  displayName?: string;
  logoData?: string;
  accentColor?: string;
  supportEmail?: string;
};

export const org = pgTable(
  'org',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique('org_slug_unique'),
    dataRegion: regionEnum('data_region').notNull(),
    planTier: packageTierEnum('plan_tier').notNull().default('p1_browser'),
    branding: jsonb('branding').$type<OrgBranding>().notNull().default({}),
    auditPepper: char('audit_pepper', { length: 64 }).notNull(),
    ssoConfig: jsonb('sso_config').$type<Record<string, unknown>>(),
    /** Phase B 11.1: stored extension policy, merged over DEFAULT_EXTENSION_POLICY on every read. */
    extensionPolicy: jsonb('extension_policy').$type<Record<string, unknown>>().notNull().default({}),
    /** Phase B Y26: null keeps recordings until deleted manually; 1..3650. */
    recordingRetentionDays: integer('recording_retention_days'),
    /** Phase A.2 section 3: org recording policy. */
    recordingMode: recordingModeEnum('recording_mode').notNull().default('assist_only'),
    /** Phase C section 1.3 step 7: the console's security-code gate before control (agent policy). */
    requireSasConfirm: boolean('require_sas_confirm').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('org_slug_format', sql`slug ~ '^[a-z0-9-]{3,40}$'`),
    check('org_recording_retention_days_range', sql`recording_retention_days is null or recording_retention_days between 1 and 3650`),
  ],
);

export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    passwordHash: text('password_hash'),
    authProvider: text('auth_provider').notNull().default('local'),
    authRef: text('auth_ref'),
    inviteTokenHash: char('invite_token_hash', { length: 64 }),
    inviteExpiresAt: tstz('invite_expires_at'),
    lastLoginAt: tstz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('user_org_id_idx').on(t.orgId), uniqueIndex('user_email_lower_unique').on(sql`lower(${t.email})`)],
);

export const technicianSeat = pgTable(
  'technician_seat',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    userId: uuid('user_id')
      .notNull()
      .unique('technician_seat_user_id_unique')
      .references(() => user.id, { onDelete: 'cascade' }),
    tier: packageTierEnum('tier').notNull().default('p1_browser'),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('technician_seat_org_id_idx').on(t.orgId)],
);

export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique('auth_session_token_hash_unique'),
    region: regionEnum('region').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [index('auth_session_user_id_idx').on(t.userId)],
);

export const loginAttempt = pgTable(
  'login_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailHash: char('email_hash', { length: 64 }).notNull(),
    ip: text('ip'),
    success: boolean('success').notNull(),
    at: tstz('at').notNull().defaultNow(),
  },
  (t) => [index('login_attempt_email_hash_idx').on(t.emailHash)],
);
