/** Enumerations and fixed constants (contracts sections 2, 3.2, 4.1, 6.1, 7, 8). Values are exact wire strings. */

export const PACKAGE_TIERS = ['p1_browser', 'p2_extension', 'p3_portable', 'p4_installed'] as const;
export type PackageTier = (typeof PACKAGE_TIERS)[number];

/** "At least tier" ordering, section 2.1. */
export const TIER_ORDER: Record<PackageTier, number> = {
  p1_browser: 0,
  p2_extension: 1,
  p3_portable: 2,
  p4_installed: 3,
};

/** True when `tier` is at most `cap` in TIER_ORDER. */
export function tierWithin(tier: PackageTier, cap: PackageTier): boolean {
  return TIER_ORDER[tier] <= TIER_ORDER[cap];
}

export const USER_ROLES = ['technician', 'senior_technician', 'org_admin', 'auditor', 'observer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles that hold a technician_seat (section 2.4). */
export const SEAT_ROLES = ['technician', 'senior_technician', 'org_admin'] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];
export function roleHasSeat(role: UserRole): role is SeatRole {
  return (SEAT_ROLES as readonly string[]).includes(role);
}

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TOKEN_TYPES = ['one_time', 'timed', 'enrollment'] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export const TOKEN_STATUSES = ['active', 'used', 'revoked', 'expired'] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

/** Section 3.2. */
export const TOKEN_LIFETIMES = {
  one_time: { defaultMin: 15, maxMin: 60 },
  timed: { defaultMin: 60, maxMin: 480 },
  enrollment: { defaultDays: 7, maxDays: 30 },
} as const;

export const SESSION_STATES = ['knocked', 'accepted', 'consent_pending', 'active', 'ended'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const CONSENT_STATES = ['pending', 'granted', 'revoked'] as const;
export type ConsentState = (typeof CONSENT_STATES)[number];

export const CONSENT_SURFACES = ['monitor', 'window', 'browser', 'unknown'] as const;
export type ConsentSurface = (typeof CONSENT_SURFACES)[number];

export const SESSION_PATHS = ['unknown', 'p2p', 'relay'] as const;
export type SessionPath = (typeof SESSION_PATHS)[number];

export const SESSION_END_REASONS = [
  'denied',
  'timeout',
  'desk_left',
  'desk_stopped',
  'consent_revoked',
  'assist_ended',
  'token_revoked',
  'error',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const PARTICIPANT_ROLES = ['assist', 'desk', 'supervisor'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const ACTOR_TYPES = ['user', 'desk', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const RECORDING_STATUSES = ['uploading', 'stored', 'failed'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const FILE_DIRECTIONS = ['assist_to_desk', 'desk_to_assist'] as const;
export type FileDirection = (typeof FILE_DIRECTIONS)[number];

export const CHECKPOINT_KINDS = ['periodic', 'verify', 'export'] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const INTEGRATION_TYPES = ['zoho_desk', 'servicenow', 'jira', 'freshdesk'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const DEVICE_STATUSES = ['enrolled', 'disabled'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** The two live participants of a Phase A session (chat `from`, `session.resumed.side`). */
export const SIDES = ['assist', 'desk'] as const;
export type Side = (typeof SIDES)[number];

export const TOKEN_REVOKE_REASONS = ['manual', 'auto_denied', 'user_disabled'] as const;
export type TokenRevokeReason = (typeof TOKEN_REVOKE_REASONS)[number];

export const LOGIN_METHODS = ['local', 'invite'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const VERIFY_FAILURE_KINDS = [
  'org_mismatch',
  'region_mismatch',
  'seq_gap',
  'prev_mismatch',
  'hash_mismatch',
  'anchor_bad_signature',
  'anchor_mismatch',
  'tail_regression',
] as const;
export type VerifyFailureKind = (typeof VERIFY_FAILURE_KINDS)[number];

/** Timers and limits (sections 3.3, 6.10, 6.11, 7.2, 7.5, 8). */
export const LIMITS = {
  knockTimeoutSec: 120,
  consentTimeoutSec: 180,
  resumeGraceSec: 30,
  helloTimeoutSec: 5,
  heartbeatIntervalSec: 25,
  heartbeatAnswerSec: 10,
  heartbeatIdleSec: 60,
  presenceTtlSec: 90,
  deskPollIntervalSec: 3,
  maxWsFrameBytes: 64 * 1024,
  maxChatText: 4000,
  autoRevokeDenials: 3,
  shortCodeLength: 12,
  recordingSingleMaxBytes: 100 * 1024 * 1024,
  recordingMaxBytes: 2 * 1024 * 1024 * 1024,
  recordingPartSize: 16 * 1024 * 1024,
  fileChunkSize: 16384,
  fileMaxBytes: 256 * 1024 * 1024,
  fileOfferNameMax: 255,
  annotTtlDefaultMs: 8000,
  annotTtlMaxMs: 60000,
  pageLimitDefault: 50,
  pageLimitMax: 200,
  turnTtlDefaultSec: 3600,
  logoMaxBytes: 200 * 1024,
  passwordMin: 10,
  passwordMax: 128,
  eventGraceSec: 60,
} as const;

export const DEFAULT_ANNOT_COLOR = '#f59e0b';

/** Data channel labels (section 8). */
export const DATA_CHANNEL_LABELS = ['ia.chat', 'ia.annot', 'ia.file', 'ia.ctrl'] as const;
export type DataChannelLabel = (typeof DATA_CHANNEL_LABELS)[number];

/** WebSocket close codes (section 7.2). */
export const WS_CLOSE = {
  normal: 1000,
  unauthenticated: 4401,
  forbidden: 4403,
  timeout: 4408,
  tokenBusy: 4409,
  sessionEnded: 4410,
  rateLimited: 4429,
} as const;
export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/** Cookie, CSRF and browser storage keys (sections 1.1, 6.1, 6.13, 12). */
export const SESSION_COOKIE_NAME = 'ia_session';
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'IndiansAssist';
export const STORAGE_KEYS = {
  region: 'ia.region',
  joinToken: 'ia.join.token',
  joinSignal: 'ia.join.signal',
  roomResume: 'ia.room.resume',
} as const;
