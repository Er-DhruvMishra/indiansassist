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
  // Phase D section 2.1: 180 d maximum so a staged GPO rollout keeps enrolling late machines.
  enrollment: { defaultDays: 7, maxDays: 180 },
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
  // Phase D section 6.3: a local approval declined / unanswered, the unattended cap reached, the device disabled.
  'consent_required',
  'policy_timeout',
  'device_disabled',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** `recorder` (Phase A.2, docs/specs/phase-a2-recorder.md section 2): the server-side recorder participant. */
export const PARTICIPANT_ROLES = ['assist', 'desk', 'supervisor', 'recorder'] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/** `device` (Phase D conventions): events a device attests with its identity-key signature. */
export const ACTOR_TYPES = ['user', 'desk', 'system', 'device'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const RECORDING_STATUSES = ['uploading', 'stored', 'failed'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

// ---------- Phase A.2 (docs/specs/phase-a2-recorder.md sections 3, 5, 9) ----------

/** Org recording policy (A.2 section 3); `assist_only` is the Phase A behaviour and the default. */
export const RECORDING_MODES = ['off', 'assist_only', 'server', 'both'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];
export const DEFAULT_RECORDING_MODE: RecordingMode = 'assist_only';

/** True when the mode lets the Assist console record (`MediaRecorder`, Phase A section 9). */
export function assistMayRecord(mode: RecordingMode | null | undefined): boolean {
  const m = mode ?? DEFAULT_RECORDING_MODE;
  return m === 'assist_only' || m === 'both';
}

/** True when the mode asks for the server recorder. */
export function serverRecords(mode: RecordingMode | null | undefined): mode is 'server' | 'both' {
  return mode === 'server' || mode === 'both';
}

/** Who made a recording (`recording.recorded_by`). */
export const RECORDING_SOURCES = ['assist', 'server'] as const;
export type RecordingSource = (typeof RECORDING_SOURCES)[number];

/** Why server recording of a session stopped (`recording.server_stopped.reason`, `recorder.leave.reason`). */
export const RECORDER_STOP_REASONS = [
  'session_ended',
  'recorder_left',
  'track_ended',
  'media_failed',
  'limit_reached',
  'disk_error',
  'shutdown',
] as const;
export type RecorderStopReason = (typeof RECORDER_STOP_REASONS)[number];

/** The far end of a relayed `webrtc.*` frame on the Desk side (A.2 section 7 N2); absent = `assist`. */
export const WEBRTC_PEERS = ['assist', 'recorder'] as const;
export type WebrtcPeer = (typeof WEBRTC_PEERS)[number];

/** `recorderId` (A.2 section 2 P4). */
export const RECORDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const FILE_DIRECTIONS = ['assist_to_desk', 'desk_to_assist'] as const;
export type FileDirection = (typeof FILE_DIRECTIONS)[number];

export const CHECKPOINT_KINDS = ['periodic', 'verify', 'export'] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

/** `webhook` (Phase E section 4.1): the generic HMAC-signed webhook type. */
export const INTEGRATION_TYPES = ['zoho_desk', 'servicenow', 'jira', 'freshdesk', 'webhook'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** Phase D rule 3.7: `superseded` (re-enrolled), `retired` (soft delete), `deregistered` (signed uninstall). */
export const DEVICE_STATUSES = ['enrolled', 'disabled', 'superseded', 'retired', 'deregistered'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** The two live participants of a Phase A session (chat `from`, `session.resumed.side`). */
export const SIDES = ['assist', 'desk'] as const;
export type Side = (typeof SIDES)[number];

export const TOKEN_REVOKE_REASONS = ['manual', 'auto_denied', 'user_disabled'] as const;
export type TokenRevokeReason = (typeof TOKEN_REVOKE_REASONS)[number];

/** `oidc`, `saml` (Phase E section 3.8): sessions minted by SSO. */
export const LOGIN_METHODS = ['local', 'invite', 'oidc', 'saml'] as const;
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
  // ---------- Phase B (docs/specs/phase-b-contracts.md section 11.2) ----------
  mirrorBatchMaxEvents: 64,
  mirrorBatchMaxMs: 200,
  mirrorBatchMaxRawBytes: 262144,
  mirrorSnapshotMaxRawBytes: 8388608,
  mirrorRelaySnapshotMaxBytes: 2097152,
  mirrorDeflateMinBytes: 1024,
  mirrorDcChunkBytes: 65536,
  mirrorDcMaxParts: 256,
  mirrorReassembleTimeoutMs: 2000,
  mirrorDcPauseBytes: 1048576,
  mirrorDcResumeBytes: 262144,
  mirrorDcStallMs: 3000,
  mirrorAckIntervalMs: 2000,
  mirrorAckTimeoutMs: 10000,
  mirrorNackIntervalMs: 2000,
  mirrorBackgroundBufferBytes: 2097152,
  mirrorCssSheetMaxBytes: 524288,
  mirrorCssTabMaxBytes: 4194304,
  mirrorRelayDataChars: 40960,
  mirrorRelayMaxParts: 256,
  mirrorRelayBudgetBytes: 524288,
  mirrorRelayBudgetWindowSec: 10,
  controlRelayMaxBytes: 16384,
  controlRelayPerSec: 10,
  controlOpsPerSec: 30,
  controlOpsBurst: 60,
  pointerMovesPerSec: 30,
  controlRequestTimeoutMs: 10000,
  promptTimeoutMs: 60000,
  promptRequestTimeoutMs: 65000,
  controlInputAggregateMs: 10000,
  revealTtlMs: 60000,
  revealFieldTextMax: 200,
  deskEventOutboxPerSec: 4,
  deskEventOutboxBurst: 15,
  assistEventsPerSec: 10,
  assistEventsBurst: 30,
  faviconMaxBytes: 8192,
  policyDenyListMax: 500,
  policyHostPatternMax: 253,
  policySelectorsMax: 50,
  policySelectorMax: 200,
  policyJsonMaxBytes: 32768,
  reasonMax: 500,
  fillValueMax: 4000,
  tabsCloseMax: 50,
  deskClientStringMax: 32,
  browserVersionMax: 8,
  recordingRetentionDaysMax: 3650,
  // ---------- Phase A.2 (docs/specs/phase-a2-recorder.md section 11) ----------
  recorderJoinTimeoutMs: 10_000,
  recorderAssignAttempts: 3,
  recorderMaxSessionsDefault: 8,
  recorderMaxSessionsMax: 256,
  recorderFramesPerSec: 200,
  recorderFramesBurst: 400,
  recorderTokenMinProd: 32,
  // Phase C section 1.3 (secure channel).
  secHandshakeTimeoutMs: 10_000,
  secFrameMaxBytes: 131_072,
  // Phase C section 13.1 additions.
  downloadGrantTtlSec: 120,
  downloadGrantMaxUses: 3,
  handoverTtlSec: 120,
  handoverMintsPer10Min: 3,
  iaconfigMaxBytes: 16_384,
  clipboardMaxBytes: 65_536,
  agentMaxKbps: 6000,
  agentStatsIntervalMs: 2000,
  pointerMovesPerSecNative: 60,
  textCharsPerSec: 400,
  textQueueMaxUnits: 2048,
  textBurstChars: 200,
  playbookBodyMaxBytes: 65_536,
  playbookTimeoutMaxSec: 900,
  playbookOutputMaxBytes: 1_048_576,
  playbookCatalogueMax: 100,
  playbookManifestMaxBytes: 32_768,
  playbookParamsMax: 16,
  fileMaxBytesNative: 2_147_483_648,
  monitorsMax: 16,
  // Phase D section 13.1 additions.
  workerCredentialTtlSec: 120,
  enrollMaxDevices: 10_000,
  deviceDisabledRetrySec: 3600,
  deviceQueueDrainMax: 100,
  wakeConfirmSec: 120,
  tamperSilentGraceSec: 900,
  enrollConfigMaxBytes: 16_384,
  deviceActionTtlDays: 7,
  deviceActionOutputMaxBytes: 1_048_576,
  maxUnattendedMinutesCap: 1440,
  localApprovalTimeoutSec: 60,
  receiptDigestMinutes: 60,
  amtSolMaxMinutes: 30,
  deviceTagsMax: 32,
  deviceGroupsPerOrgMax: 500,
  fleetPageMax: 200,
  // Phase E section 13.1 additions.
  ssoFlowTtlSec: 600,
  ssoDomainsMax: 20,
  ssoDomainRecheckHours: 168,
  ssoBreakGlassMax: 2,
  breakGlassSessionHours: 1,
  samlResponseMaxBytes: 262_144,
  ticketPushMaxAttempts: 6,
  ticketPushManualRetries: 3,
  ticketBodyMax: 20_000,
  summaryInputMaxBytes: 131_072,
  summaryEventsMax: 400,
  summaryTranscriptTtlSec: 1800,
  summaryTranscriptGraceSec: 20,
  summaryTranscriptUploadMaxBytes: 524_288,
  summaryMaxAttempts: 4,
  /** Per region (section 5.8c): the worker runs only on the region's sweeper lease holder. */
  summaryConcurrency: 2,
  webhookRotationOverlapHours: 24,
} as const;

export const DEFAULT_ANNOT_COLOR = '#f59e0b';

/**
 * Data channel labels (Phase A section 8, Phase B section 4.2). A P1 session creates only the first four
 * (`P1_DATA_CHANNEL_LABELS`); a P2 session adds `ia.mirror` and `ia.control`.
 */
export const DATA_CHANNEL_LABELS = [
  'ia.chat',
  'ia.annot',
  'ia.file',
  'ia.ctrl',
  'ia.mirror',
  'ia.control',
  // Phase C section 1.3 / 5.1: the handshake channel and the playbook output channel of a P3 session.
  'ia.sec',
  'ia.playbook',
] as const;
export type DataChannelLabel = (typeof DATA_CHANNEL_LABELS)[number];
export const P1_DATA_CHANNEL_LABELS = ['ia.chat', 'ia.annot', 'ia.file', 'ia.ctrl'] as const satisfies readonly DataChannelLabel[];

/** WebSocket close codes (section 7.2). */
export const WS_CLOSE = {
  normal: 1000,
  unauthenticated: 4401,
  forbidden: 4403,
  timeout: 4408,
  tokenBusy: 4409,
  sessionEnded: 4410,
  rateLimited: 4429,
  // Phase C section 7.2: the user instance replaced by the elevated hand-over child.
  handedOver: 4411,
  // Phase D section 3.4: `device_unauthenticated` and `device_disabled` on `/signal/device`.
  deviceUnauthenticated: 4412,
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

// ---------- Phase B enums (docs/specs/phase-b-contracts.md sections 3, 4, 5, 8, 11.2) ----------

/** Ordered consent levels of a P2 session (section 5.2). */
export const CONSENT_LEVELS = ['view', 'tab_control', 'in_page', 'deep_control'] as const;
export type ConsentLevel = (typeof CONSENT_LEVELS)[number];
export const CONSENT_LEVEL_ORDER: Record<ConsentLevel, number> = { view: 0, tab_control: 1, in_page: 2, deep_control: 3 };

/** True when level `a` is at least level `b`. */
export function levelAtLeast(a: ConsentLevel, b: ConsentLevel): boolean {
  // Phase C section 3.4 family rule: a P3-only level (`control`, `elevated`) must never be compared here.
  if (!(a in CONSENT_LEVEL_ORDER) || !(b in CONSENT_LEVEL_ORDER)) throw new Error(`not a P2 consent level: ${String(a)} / ${String(b)}`);
  return CONSENT_LEVEL_ORDER[a] >= CONSENT_LEVEL_ORDER[b];
}

/** The lower of two levels. */
export function minLevel(a: ConsentLevel, b: ConsentLevel): ConsentLevel {
  return CONSENT_LEVEL_ORDER[a] <= CONSENT_LEVEL_ORDER[b] ? a : b;
}

export function isConsentLevel(x: unknown): x is ConsentLevel {
  return typeof x === 'string' && (CONSENT_LEVELS as readonly string[]).includes(x);
}

export const MIRROR_SCOPES = ['current_tab', 'all_tabs'] as const;
export type MirrorScope = (typeof MIRROR_SCOPES)[number];

/** Phase C section 3.1: `native` = the Rust agent or the Android host. */
export const DESK_CLIENT_KINDS = ['web', 'extension', 'native'] as const;
export type DeskClientKind = (typeof DESK_CLIENT_KINDS)[number];

export const DESK_BROWSERS = ['chrome', 'edge', 'other'] as const;
export type DeskBrowser = (typeof DESK_BROWSERS)[number];

/** `android` (Phase C section 3.1) only with `kind: 'native'` (the `deskClientSchema` refinement). */
export const DESK_OSES = ['windows', 'mac', 'linux', 'cros', 'other', 'android'] as const;
export type DeskOs = (typeof DESK_OSES)[number];

/** `os` (Phase C section 3.8): OS-level input of a native Desk; the B `input.mode` op keeps `dom` / `debugger`. */
export const INPUT_MODES = ['dom', 'debugger', 'os'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

export const MIRROR_TRANSPORTS = ['dc', 'relay'] as const;
export type MirrorTransport = (typeof MIRROR_TRANSPORTS)[number];

export const MIRROR_START_REASONS = ['consent', 'resumed', 'attach', 'reconnect'] as const;
export type MirrorStartReason = (typeof MIRROR_START_REASONS)[number];

export const MIRROR_STOP_REASONS = ['paused', 'policy', 'all_tabs_closed', 'too_large', 'ended', 'revoked', 'error'] as const;
export type MirrorStopReason = (typeof MIRROR_STOP_REASONS)[number];

export const MASK_SCOPES = ['field', 'tab'] as const;
export type MaskScope = (typeof MASK_SCOPES)[number];

export const FIELD_KINDS = ['input', 'textarea', 'select', 'contenteditable', 'text'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const MASK_REFUSE_CAUSES = ['refused', 'timeout', 'not_unmaskable', 'policy', 'bad_target'] as const;
export type MaskRefuseCause = (typeof MASK_REFUSE_CAUSES)[number];

export const MASK_RESTORE_CAUSES = ['desk', 'blur', 'ttl', 'navigation', 'pause', 'level', 'end'] as const;
export type MaskRestoreCause = (typeof MASK_RESTORE_CAUSES)[number];

export const BACKSTAGE_OUTCOMES = ['closed', 'kept', 'brought_to_front'] as const;
export type BackstageOutcome = (typeof BACKSTAGE_OUTCOMES)[number];

export const BACKSTAGE_ACTIONS = ['close', 'keep', 'bring_to_front'] as const;
export type BackstageAction = (typeof BACKSTAGE_ACTIONS)[number];

/** `text` (Phase C section 3.8): characters typed through `os.text`. */
export const INPUT_KINDS = ['pointer', 'key', 'scroll', 'fill', 'text'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** Fixed-length mask for secrets and masked text (section 4.1): discloses nothing about the length. */
export const MASK_FIXED = '********';

/** Placeholder extension id used by fixtures and docs until Web Store publication (section 2.1 J4). */
export const EXTENSION_ID_PLACEHOLDER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Media type of an Assist-side rrweb mirror recording (section 4.7). */
export const RRWEB_RECORDING_MIME = 'application/x-ia-rrweb+jsonl';

// Phase C (docs/specs/phase-c-contracts.md section 13.1): the P3 enumerations live in enums-p3.ts.
export * from './enums-p3.js';
// Phase D (docs/specs/phase-d-contracts.md section 13.1): the P4 enumerations live in enums-p4.ts.
export * from './enums-p4.js';
// Phase E (docs/specs/phase-e-contracts.md section 13.1): the enterprise enumerations live in enums-e.ts.
export * from './enums-e.js';
