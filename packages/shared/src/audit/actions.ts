/**
 * Phase A audit action names and per-action `data` schemas (contracts section 5.3). Every schema is strict
 * (unknown keys fail) and sanitises every string with the section 5.3 rules before hashing.
 * PII (emails, Desk labels, user agents, file names) only ever appears as a `...Hash` key.
 */
import { z } from 'zod';
import {
  AGENT_CONSENT_LEVELS,
  CONSENT_LEVELS,
  CONSENT_SURFACES,
  MIRROR_SCOPES,
  FILE_DIRECTIONS,
  LOGIN_METHODS,
  PACKAGE_TIERS,
  SESSION_END_REASONS,
  SESSION_PATHS,
  SESSION_STATES,
  SIDES,
  TOKEN_REVOKE_REASONS,
  TOKEN_TYPES,
  USER_ROLES,
  USER_STATUSES,
  VERIFY_FAILURE_KINDS,
} from '../enums.js';
import { sanitiseText, SANITISE_LIMITS } from './sanitise.js';
import { P2_AUDIT_ACTIONS, P2_CHAIN_SCHEMAS } from './actions-p2.js';
import {
  A2_AUDIT_ACTIONS,
  A2_CHAIN_SCHEMAS,
  recordingCameraIdSchema,
  recordingFailedDataSchema,
  recordingStoredDataSchema,
} from './actions-a2.js';
import { P3_AUDIT_ACTIONS, P3_CHAIN_SCHEMAS } from './actions-p3.js';
import { P4_AUDIT_ACTIONS, P4_CHAIN_SCHEMAS } from './actions-p4.js';
import { E_AUDIT_ACTIONS, E_CHAIN_SCHEMAS } from './actions-e.js';
import { F_AUDIT_ACTIONS, F_CHAIN_SCHEMAS } from './actions-f.js';

export * from './actions-p2.js';
export * from './actions-a2.js';
export * from './actions-p3.js';
export * from './actions-p4.js';
export * from './actions-e.js';
export * from './actions-f.js';

export const AUDIT_ACTIONS = [
  'auth.signup',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'user.invited',
  'user.role_changed',
  'user.status_changed',
  'org.branding_updated',
  'token.created',
  'token.revoked',
  'session.knock',
  'session.accepted',
  'session.denied',
  'session.consent_granted',
  'session.consent_revoked',
  'session.started',
  'session.resumed',
  'session.path_changed',
  'session.ended',
  'chat.relayed',
  'file.sent',
  'file.received',
  'recording.started',
  'recording.stored',
  'recording.failed',
  'signal.forbidden',
  'audit.anchored',
  'audit.exported',
  'audit.verified',
  'elevation.requested',
  'session.supervisor_joined',
  // Phase B (docs/specs/phase-b-contracts.md section 3.6)
  ...P2_AUDIT_ACTIONS,
  // Phase A.2 (docs/specs/phase-a2-recorder.md section 6)
  ...A2_AUDIT_ACTIONS,
  // Phase C (docs/specs/phase-c-contracts.md sections 3.8, 7.5, 8.5)
  ...P3_AUDIT_ACTIONS,
  // Phase D (docs/specs/phase-d-contracts.md section 13.3)
  ...P4_AUDIT_ACTIONS,
  // Phase E (docs/specs/phase-e-contracts.md section 13.3)
  ...E_AUDIT_ACTIONS,
  // Phase F (docs/specs/phase-f-contracts.md section 13.3)
  ...F_AUDIT_ACTIONS,
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Reserved names: valid action strings that are never written (`elevation.requested` is written since Phase C). */
export const RESERVED_AUDIT_ACTIONS = ['session.supervisor_joined'] as const;

export function isAuditAction(x: unknown): x is AuditAction {
  return typeof x === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(x);
}

const text = (limit: number = SANITISE_LIMITS.default) => z.string().transform((s) => sanitiseText(s, limit));
const id = text();
const hash = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
const int = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const iso = text();
const tier = z.enum(PACKAGE_TIERS);

const fileData = z.strictObject({
  fileId: int,
  direction: z.enum(FILE_DIRECTIONS),
  nameHash: hash,
  bytes: int,
  sha256: hash,
});

const empty = z.strictObject({});

const SCHEMAS = {
  'auth.signup': z.strictObject({ emailHash: hash }),
  'auth.login': z.strictObject({ method: z.enum(LOGIN_METHODS) }),
  'auth.login_failed': z.strictObject({ userId: id }),
  'auth.logout': empty,
  'auth.password_changed': empty,
  'user.invited': z.strictObject({
    userId: id,
    emailHash: hash,
    role: z.enum(USER_ROLES),
    tier: tier.nullable(),
  }),
  'user.role_changed': z.strictObject({
    userId: id,
    from: z.enum(USER_ROLES),
    to: z.enum(USER_ROLES),
    fromTier: tier.nullable(),
    toTier: tier.nullable(),
  }),
  'user.status_changed': z.strictObject({
    userId: id,
    from: z.enum(USER_STATUSES),
    to: z.enum(USER_STATUSES),
    revokedSessions: int,
    revokedTokens: int,
  }),
  'org.branding_updated': z.strictObject({ fields: z.array(text(100)) }),
  'token.created': z.strictObject({ tokenId: id, tier, typ: z.enum(TOKEN_TYPES), expiresAt: iso }),
  'token.revoked': z.strictObject({ tokenId: id, reason: z.enum(TOKEN_REVOKE_REASONS) }),
  // Phase D section 13.3: the P4 branches (a device session has no token; the device is the credential).
  'session.knock': z.union([
    z.strictObject({ tokenId: id, deskLabelHash: hash, userAgentHash: hash }),
    z.strictObject({ deviceId: id, keyId: z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex-char key id') }),
  ]),
  'session.accepted': z.union([
    z.strictObject({ tokenId: id, onBehalfOf: id.nullable() }),
    z.strictObject({
      deviceId: id,
      unattended: z.boolean(),
      reason: text(SANITISE_LIMITS.reason).nullable(),
      onBehalfOf: z.null(),
    }),
  ]),
  'session.denied': z.strictObject({ tokenId: id, revokeToken: z.boolean() }),
  // `level`, `scope`, `backstage`: present for P2 sessions only (Phase B Y5); `level` (P3 family), `monitors`,
  // `clipboard`: present for P3 sessions only (Phase C section 3.8).
  'session.consent_granted': z.union([
    z.strictObject({
      surface: z.enum(CONSENT_SURFACES),
      level: z.enum(CONSENT_LEVELS).optional(),
      scope: z.enum(MIRROR_SCOPES).optional(),
      backstage: z.boolean().optional(),
    }),
    z.strictObject({
      surface: z.literal('monitor'),
      level: z.enum(AGENT_CONSENT_LEVELS),
      monitors: z.number().int().min(1).max(16),
      clipboard: z.boolean(),
    }),
  ]),
  'session.consent_revoked': empty,
  'session.started': z.strictObject({ path: z.enum(SESSION_PATHS) }),
  'session.resumed': z.strictObject({
    side: z.enum(SIDES),
    fromState: z.enum(SESSION_STATES),
    toState: z.enum(SESSION_STATES),
  }),
  'session.path_changed': z.strictObject({ from: z.enum(SESSION_PATHS), to: z.enum(SESSION_PATHS) }),
  'session.ended': z.strictObject({
    endReason: z.enum(SESSION_END_REASONS),
    durationMs: int.nullable(),
    path: z.enum(SESSION_PATHS),
  }),
  'chat.relayed': z.strictObject({ count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }),
  'file.sent': fileData,
  'file.received': fileData,
  // Phase F section 6.5a: optional `cameraId` on a recording of the phone camera's track.
  'recording.started': z.strictObject({ cameraId: recordingCameraIdSchema }),
  // Phase A.2: optional `source: 'server'` (server recordings only); Phase F: optional `cameraId`.
  'recording.stored': recordingStoredDataSchema,
  'recording.failed': recordingFailedDataSchema,
  // `suppressed`: attempts on the same (connection, session) since the previous entry that were coalesced (SEC-05).
  'signal.forbidden': z.strictObject({
    connectionId: id,
    messageType: text(100),
    sessionId: id.nullable(),
    suppressed: z.number().int().nonnegative().optional(),
  }),
  'audit.anchored': z.strictObject({ seq: int, tail: hash, ts: iso, kid: text(64), sig: text(200) }),
  'audit.exported': z.strictObject({
    format: z.literal('jsonl'),
    count: int,
    fromSeq: int.nullable(),
    toSeq: int.nullable(),
  }),
  'audit.verified': z.strictObject({
    ok: z.boolean(),
    checked: int,
    failure: z.strictObject({ kind: z.enum(VERIFY_FAILURE_KINDS), seq: z.number().int() }).nullable(),
  }),
  // Phase C section 7.5: written by the console (`POST events`), the technician's reason in the `reason` column.
  'elevation.requested': z.strictObject({ opId: z.string().regex(/^[0-9a-f]{16}$/, 'expected a 16-hex-char opId') }),
  'session.supervisor_joined': empty.refine(
    () => false,
    'session.supervisor_joined is reserved and not written in Phase A',
  ),
  ...P2_CHAIN_SCHEMAS,
  ...A2_CHAIN_SCHEMAS,
  ...P3_CHAIN_SCHEMAS,
  ...P4_CHAIN_SCHEMAS,
  ...E_CHAIN_SCHEMAS,
  ...F_CHAIN_SCHEMAS,
} satisfies Record<AuditAction, z.ZodType>;

export type AuditDataSchemas = typeof SCHEMAS;
export type AuditDataOf<A extends AuditAction> = z.output<AuditDataSchemas[A]>;
export type AuditDataInputOf<A extends AuditAction> = z.input<AuditDataSchemas[A]>;
/** Union of every action's validated `data` object. */
export type AuditData = { [A in AuditAction]: AuditDataOf<A> }[AuditAction];

/** Per-action zod schema (with sanitising transforms). Throws on an unknown action. */
export function auditDataSchema<A extends AuditAction>(action: A): AuditDataSchemas[A] {
  const schema = SCHEMAS[action];
  if (!schema) throw new Error(`unknown audit action: ${String(action)}`);
  return schema;
}

/** Sanitises `reason` (max 500) and `actor.label` (max 80) exactly as the chain requires. */
export function sanitiseReason(reason: string | null | undefined): string | null {
  return reason === null || reason === undefined ? null : sanitiseText(reason, SANITISE_LIMITS.reason);
}

export function sanitiseActorLabel(label: string): string {
  return sanitiseText(label, SANITISE_LIMITS.label);
}

/** `desk:<first 8 chars of desk_ref>` (section 5.3). */
export function deskActorLabel(deskRef: string): string {
  return `desk:${deskRef.slice(0, 8)}`;
}
