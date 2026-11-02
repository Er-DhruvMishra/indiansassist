/**
 * Phase F enumerations (docs/specs/phase-f-contracts.md section 13.1), re-exported by enums.ts (the enums-e.ts
 * pattern). Values are exact wire strings; each list has one owning definition here.
 */

// ---------- mail (section 4) ----------

/** `ia_mail_sent_total{kind}` (section 4.1e). */
export const MAIL_KINDS = ['invite', 'reset', 'reset_notice', 'break_glass', 'receipt', 'erasure'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** `auth.password_reset_requested.outcome` (section 4.3g). */
export const RESET_OUTCOMES = ['mailed', 'sso_notice', 'throttled', 'send_failed', 'no_mailer'] as const;
export type ResetOutcome = (typeof RESET_OUTCOMES)[number];

// ---------- erasure (section 5) ----------

/** `org_erasure.state` (section 5.1). */
export const ERASURE_STATES = [
  'pending_confirmation',
  'pending_approval',
  'cooling_off',
  'executing',
  'completed',
  'cancelled',
  'expired',
] as const;
export type ErasureState = (typeof ERASURE_STATES)[number];

/** The states in which an erasure is open (at most one per org: the partial unique index of section 13.2). */
export const OPEN_ERASURE_STATES = [
  'pending_confirmation',
  'pending_approval',
  'cooling_off',
  'executing',
] as const satisfies readonly ErasureState[];
export type OpenErasureState = (typeof OPEN_ERASURE_STATES)[number];

/** The execution steps of section 5.3, in order (`org_erasure.progress` keys). */
export const ERASURE_STEPS = ['freeze', 'stop', 'chain', 'objects', 'rows', 'seal', 'verify', 'certify', 'notify'] as const;
export type ErasureStep = (typeof ERASURE_STEPS)[number];

// ---------- camera (section 6) ----------

/** `camera.stop.reason`, `camera.state.reason`, `camera.ended.by` (sections 6.3, 6.4, 13.3). */
export const CAMERA_STOP_REASONS = [
  'declined',
  'phone_stopped',
  'assist',
  'session_ended',
  'link_expired',
  'disconnected',
  'no_camera',
  'permission_denied',
  'error',
] as const;
export type CameraStopReason = (typeof CAMERA_STOP_REASONS)[number];

/** `camera.ready.facing` (section 6.4). */
export const CAMERA_FACINGS = ['environment', 'user', 'unknown'] as const;
export type CameraFacing = (typeof CAMERA_FACINGS)[number];

/** `camera.state.state` (section 6.4). */
export const CAMERA_STATES = ['linked', 'joined', 'live', 'ended'] as const;
export type CameraState = (typeof CAMERA_STATES)[number];

// ---------- installers and Linux (sections 8, 17.8) ----------

/** `installerBuildSchema.format` (section 8.11); `pkg` is the macOS installer (section 17.8). */
export const INSTALLER_FORMATS = ['msi', 'deb', 'rpm', 'pkg'] as const;
export type InstallerFormat = (typeof INSTALLER_FORMATS)[number];

/** `installerBuildSchema.platform` (sections 8.11, 17.8). */
export const INSTALLER_PLATFORMS = ['windows', 'linux', 'macos'] as const;
export type InstallerPlatform = (typeof INSTALLER_PLATFORMS)[number];

/** `interactiveStateSchema.display` (section 8.3e): the type of the target Linux graphical session. */
export const LINUX_DISPLAY_TYPES = ['x11', 'wayland'] as const;
export type LinuxDisplayType = (typeof LINUX_DISPLAY_TYPES)[number];

/** `deviceHelloClientSchema.os` (sections 8.3e, 17.8); absent = `windows`. */
export const DEVICE_HELLO_OSES = ['windows', 'linux', 'macos'] as const;
export type DeviceHelloOs = (typeof DEVICE_HELLO_OSES)[number];

/** `recording.source` (section 6.5a): the Desk's screen or the phone camera. */
export const RECORDING_TRACK_SOURCES = ['desk', 'camera'] as const;
export type RecordingTrackSource = (typeof RECORDING_TRACK_SOURCES)[number];
