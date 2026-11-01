/**
 * Phase D enumerations (docs/specs/phase-d-contracts.md section 13.1), re-exported by enums.ts. Values are exact wire
 * strings, mirrored by the Rust `serde` types of the installed service (`ia_core::types`); the cross-language list is
 * `test/fixtures/agent/agent-names.json` plus `test/fixtures/fleet/*.json`.
 */
import { AGENT_FEATURES } from './enums-p3.js';

/** Section 6.1: whether a device may be entered with nobody present. */
export const UNATTENDED_MODES = ['allow', 'approval_only', 'deny'] as const;
export type UnattendedMode = (typeof UNATTENDED_MODES)[number];

/** `device.platform` (section 13.1a); Phase D enrols `windows` only. */
export const DEVICE_PLATFORMS = ['windows', 'macos', 'linux'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** Rule 9.1. */
export const DEVICE_ACTION_KINDS = ['playbook_run', 'file_push', 'print', 'message'] as const;
export type DeviceActionKind = (typeof DEVICE_ACTION_KINDS)[number];

/** Rule 9.2. */
export const DEVICE_ACTION_STATES = [
  'queued',
  'dispatched',
  'awaiting_approval',
  'running',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export type DeviceActionState = (typeof DEVICE_ACTION_STATES)[number];
/** States after which an action never changes again. */
export const DEVICE_ACTION_FINAL_STATES = ['done', 'failed', 'cancelled', 'expired'] as const satisfies readonly DeviceActionState[];

/** Rule 10.5: device-recorded tamper causes (the server-derived suspicion is `tamper.suspected`). */
export const TAMPER_CAUSES = ['stopped', 'disabled', 'deleted', 'binary_changed', 'config_changed', 'watchdog_restarted'] as const;
export type TamperCause = (typeof TAMPER_CAUSES)[number];
export const TAMPER_STATES = ['ok', 'alerted', 'suspected'] as const;
export type TamperState = (typeof TAMPER_STATES)[number];

/** Section 8.1. */
export const WAKE_METHODS = ['wol', 'amt', 'auto'] as const;
export type WakeMethod = (typeof WAKE_METHODS)[number];
export const WAKE_STATES = ['pending', 'dispatched', 'woke', 'failed'] as const;
export type WakeState = (typeof WAKE_STATES)[number];
export const WAKE_FAIL_CAUSES = ['no_waker', 'no_confirm', 'amt_unavailable', 'amt_unreachable', 'waker_error'] as const;
export type WakeFailCause = (typeof WAKE_FAIL_CAUSES)[number];

/** Section 3.4: `none` = nobody logged on, `locked` = logged on but locked / disconnected, `active` = present. */
export const INTERACTIVE_STATES = ['none', 'locked', 'active'] as const;
export type InteractiveStateName = (typeof INTERACTIVE_STATES)[number];

/** Section 6.2: what the desktop worker does at launch. */
export const CONSENT_DECISIONS = ['auto_grant', 'local_approval', 'local_consent'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/** Who authorised an unattended session or a device action (section 6.3, rule 9.2). */
export const APPROVED_BY = ['policy', 'local_user', 'auto_after_timeout'] as const;
export type ApprovedBy = (typeof APPROVED_BY)[number];

/** Section 5.4: who turned input lock / privacy screen on or off. */
export const LOCK_CHANGE_CAUSES = ['technician', 'user_sas', 'level_drop', 'teardown', 'session_end', 'user_declined'] as const;
export type LockChangeCause = (typeof LOCK_CHANGE_CAUSES)[number];

/** Rule 5.1c. */
export const SECURE_DESKTOP_SURFACES = ['logon', 'uac', 'lock'] as const;
export type SecureDesktopSurface = (typeof SECURE_DESKTOP_SURFACES)[number];

/** Rule 8.4b. */
export const AMT_OPS = ['power_on', 'boot_redirect', 'sol_open', 'sol_close'] as const;
export type AmtOp = (typeof AMT_OPS)[number];
export const AMT_BOOT_TARGETS = ['pxe', 'hdd', 'cd'] as const;
export type AmtBootTarget = (typeof AMT_BOOT_TARGETS)[number];

/** Conventions table: the `purpose` of a sealed one-use secret. */
export const SEAL_PURPOSES = ['wake-mac', 'amt-cred', 'vault-secret'] as const;
export type SealPurpose = (typeof SEAL_PURPOSES)[number];

/** Section 3.8: the eight device signature domains. */
export const DEVICE_SIG_DOMAINS = [
  'ia-enroll-v1',
  'ia-dev-v1',
  'ia-rot-v1',
  'ia-rot-new-v1',
  'ia-dereg-v1',
  'ia-tamper-v1',
  'ia-action-v1',
  'ia-sas-v1',
] as const;
export type DeviceSigDomain = (typeof DEVICE_SIG_DOMAINS)[number];

/**
 * Section 13.1a `ServiceCapabilities.features`: the C agent features plus the service-grade ones. `input_lock` and
 * `privacy_screen` are already in AGENT_FEATURES (a C agent never advertises them, a P4 worker does).
 */
export const SERVICE_FEATURES = [...AGENT_FEATURES, 'secure_desktop', 'service_input', 'waker', 'amt', 'amt_proxy', 'sas'] as const;
export type ServiceFeature = (typeof SERVICE_FEATURES)[number];
