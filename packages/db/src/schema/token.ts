/**
 * Support tokens, devices and device groups (contracts section 4.2: token, device; Phase D section 13.2: the device
 * columns, device_group and the enrollment counters of a token).
 */
import { sql } from 'drizzle-orm';
import { char, check, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  devicePlatformEnum,
  deviceStatusEnum,
  packageTierEnum,
  regionEnum,
  tamperStateEnum,
  tokenStatusEnum,
  tokenTypeEnum,
} from './enums.js';
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
    /** Phase D section 2.1: devices an enrollment token may enrol, and how many it did (row-locked counter). */
    maxDevices: integer('max_devices').notNull().default(1),
    devicesEnrolled: integer('devices_enrolled').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('token_max_devices_range', sql`max_devices between 1 and 10000`),
    check('token_devices_enrolled_cap', sql`devices_enrolled between 0 and max_devices`),
    index('token_org_id_idx').on(t.orgId),
    index('token_created_by_idx').on(t.createdBy),
    index('token_org_status_idx').on(t.orgId, t.status),
    index('token_expires_at_idx').on(t.expiresAt),
    uniqueIndex('token_short_code_active_unique')
      .on(t.shortCode)
      .where(sql`status = 'active'`),
  ],
);

/** Phase D section 2.2: an org-scoped set of devices carrying their default unattended policy and tags. */
export const deviceGroup = pgTable(
  'device_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    name: text('name').notNull(),
    description: text('description'),
    /** `UnattendedPolicyPatch`. */
    defaultPolicy: jsonb('default_policy').$type<Record<string, unknown>>().notNull().default({}),
    defaultTags: text('default_tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notifyEmail: text('notify_email'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('device_group_org_id_idx').on(t.orgId), unique('device_group_org_name_unique').on(t.orgId, t.name)],
);

export const device = pgTable(
  'device',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => org.id),
    name: text('name').notNull(),
    /** base64url Ed25519 identity public key (Phase D conventions). */
    publicKey: text('public_key'),
    status: deviceStatusEnum('status').notNull().default('enrolled'),
    /** Deprecated (Phase D section 2.2): kept for append-only migration safety, never written or read in P4. */
    groupName: text('group_name'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** `ServiceCapabilities`. */
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    enrolledByTokenId: uuid('enrolled_by_token_id').references(() => token.id),
    lastSeenAt: tstz('last_seen_at'),
    // ---------- Phase D section 13.2 ----------
    region: regionEnum('region').notNull(),
    platform: devicePlatformEnum('platform').notNull().default('windows'),
    /** `kidOf(public_key)`. */
    keyId: text('key_id'),
    /** base64url X25519 sealing public key (required by the api for every P4 row). */
    kexPublicKey: text('kex_public_key'),
    osVersion: text('os_version'),
    agentVersion: text('agent_version'),
    serviceVersion: text('service_version'),
    arch: text('arch'),
    hwFingerprint: char('hw_fingerprint', { length: 64 }),
    lastIp: text('last_ip'),
    groupId: uuid('group_id').references(() => deviceGroup.id),
    /** `UnattendedPolicyPatch` override (null = the group / org policy). */
    unattendedPolicy: jsonb('unattended_policy').$type<Record<string, unknown>>(),
    /** `InteractiveState`. */
    interactive: jsonb('interactive').$type<Record<string, unknown>>(),
    /** `LanSegment`. */
    lanSegment: jsonb('lan_segment').$type<Record<string, unknown>>(),
    /** The wake MAC, XChaCha20-Poly1305 under the region fleet data key (rule 8.2c); never plaintext. */
    macEnc: text('mac_enc'),
    /** HMAC-SHA256 of the MAC under a subkey of the fleet data key (de-duplication). */
    macHash: char('mac_hash', { length: 64 }),
    /** `AmtInventory`. */
    amt: jsonb('amt').$type<Record<string, unknown>>(),
    tamperState: tamperStateEnum('tamper_state').notNull().default('ok'),
    notifyEmail: text('notify_email'),
    /** Rule 3.7b: the one-time nonce of an armed key rotation. */
    rotationNonce: text('rotation_nonce'),
    enrolledAt: tstz('enrolled_at'),
    firstSeenAt: tstz('first_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('device_org_id_idx').on(t.orgId),
    index('device_org_status_idx').on(t.orgId, t.status),
    index('device_org_group_idx').on(t.orgId, t.groupId),
    index('device_lan_subnet_idx').on(sql`(${t.lanSegment}->>'subnetHash')`),
    index('device_org_mac_hash_idx').on(t.orgId, t.macHash),
  ],
);
