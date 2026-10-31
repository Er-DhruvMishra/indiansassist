/**
 * Phase C enumerations (docs/specs/phase-c-contracts.md sections 1.3-8, 13.1), re-exported by enums.ts. Values are
 * exact wire strings, mirrored by `ia_core::types` (Rust) and the Kotlin host; the cross-language list is
 * `test/fixtures/agent/agent-names.json`.
 */
import type { PackageTier } from './enums.js';

/**
 * Phase C section 1.3: the secure-channel (`ia.sec`) names. Every P3 data channel except `ia.sec` is encrypted;
 * `SEC_LABEL_IDS` is the label byte of the frame nonce. Mirrored by `ia_core::sec` (Rust) and `SecChannel` (Kotlin).
 */
export const SEC_SUITE = 'x25519-xchacha20poly1305-hkdfsha256' as const;
export const SEC_ENCRYPTED_LABELS = ['ia.control', 'ia.file', 'ia.playbook', 'ia.chat', 'ia.annot', 'ia.ctrl'] as const;
export type SecEncryptedLabel = (typeof SEC_ENCRYPTED_LABELS)[number];
export const SEC_LABEL_IDS: Record<SecEncryptedLabel, number> = {
  'ia.control': 1,
  'ia.file': 2,
  'ia.playbook': 3,
  'ia.chat': 4,
  'ia.annot': 5,
  'ia.ctrl': 6,
};
export const P3_DATA_CHANNEL_LABELS = ['ia.sec', 'ia.chat', 'ia.annot', 'ia.file', 'ia.ctrl', 'ia.control', 'ia.playbook'] as const;
export const SEC_FAIL_REASONS = [
  'suite',
  'commit',
  'fingerprint',
  'key',
  'mac',
  'timeout',
  'replay',
  'decrypt',
  'oversize',
  'channel',
] as const;
export type SecFailReason = (typeof SEC_FAIL_REASONS)[number];
export const SEC_SIDES = ['desk', 'assist'] as const;
export type SecSide = (typeof SEC_SIDES)[number];

/** Phase C section 3.4: the P3 consent-level family, ordered. Distinct from the P2 `CONSENT_LEVELS`. */
export const AGENT_CONSENT_LEVELS = ['view', 'control', 'elevated'] as const;
export type AgentConsentLevel = (typeof AGENT_CONSENT_LEVELS)[number];
export const AGENT_CONSENT_LEVEL_ORDER: Record<AgentConsentLevel, number> = { view: 0, control: 1, elevated: 2 };
export function isAgentConsentLevel(v: unknown): v is AgentConsentLevel {
  return typeof v === 'string' && (AGENT_CONSENT_LEVELS as readonly string[]).includes(v);
}
/** `a >= b` within the P3 family; throws on a value of the other family (section 3.4 family rule). */
export function agentLevelAtLeast(a: AgentConsentLevel, b: AgentConsentLevel): boolean {
  if (!isAgentConsentLevel(a) || !isAgentConsentLevel(b)) throw new Error(`not a P3 consent level: ${String(a)} / ${String(b)}`);
  return AGENT_CONSENT_LEVEL_ORDER[a] >= AGENT_CONSENT_LEVEL_ORDER[b];
}
/**
 * Every value the `consent_level` column (and `consent.changed.level`) can hold: both families in one enum
 * (Phase C section 3.4, 13.2). Readers branch on `consentLevelFamily(tier)` before comparing.
 */
export const STORED_CONSENT_LEVELS = ['view', 'tab_control', 'in_page', 'deep_control', 'control', 'elevated'] as const;
export type StoredConsentLevel = (typeof STORED_CONSENT_LEVELS)[number];
/** Which consent-level family a tier uses (section 3.4): compare levels only after branching on this. */
export function consentLevelFamily(tier: PackageTier): 'p2' | 'p3' {
  return tier === 'p3_portable' ? 'p3' : 'p2';
}

/** Phase C sections 3.1-8 enumerations, mirrored by `ia_core::types` and the Kotlin host. */
export const ELEVATION_LEVELS = ['user', 'admin'] as const;
export type ElevationLevel = (typeof ELEVATION_LEVELS)[number];
export const AGENT_FEATURES = [
  'screen',
  'multi_monitor',
  'input',
  'input_text',
  'clipboard',
  'files',
  'chat',
  'voice',
  'elevation',
  'playbooks',
  'nav',
  'input_lock',
  'privacy_screen',
  /** Answers the A.2 server recorder's `webrtc.offer { peer: 'recorder' }`; the P3 recorder is only assigned to a Desk advertising it. */
  'recorder',
] as const;
export type AgentFeature = (typeof AGENT_FEATURES)[number];
export const VIDEO_ENCODERS = ['vp8', 'vp9', 'h264', 'av1'] as const;
export type VideoEncoder = (typeof VIDEO_ENCODERS)[number];
export const QUALITY_PRESETS = ['auto', 'sharp', 'smooth', 'floor'] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];
export const TOKEN_SOURCES = ['arg', 'deeplink', 'sidecar', 'filename', 'clipboard', 'manual'] as const;
export type TokenSource = (typeof TOKEN_SOURCES)[number];
export const PLAYBOOK_INTERPRETERS = ['powershell', 'cmd', 'sh'] as const;
export type PlaybookInterpreter = (typeof PLAYBOOK_INTERPRETERS)[number];
export const PLAYBOOK_ERRORS = [
  'timeout',
  'cancelled',
  'spawn_failed',
  'hash_mismatch',
  'not_allowed',
  'elevation_required',
  'busy',
  'output_error',
] as const;
export type PlaybookError = (typeof PLAYBOOK_ERRORS)[number];
export const ELEVATION_DENY_CAUSES = ['refused', 'timeout', 'uac_cancelled', 'policy'] as const;
export type ElevationDenyCause = (typeof ELEVATION_DENY_CAUSES)[number];
export const ELEVATION_FAIL_ERRORS = [
  'launch_failed',
  'handover_expired',
  'handover_rejected',
  'connect_failed',
  'uac_unavailable',
  'image_mismatch',
] as const;
export type ElevationFailError = (typeof ELEVATION_FAIL_ERRORS)[number];
export const NAV_ACTIONS = ['back', 'home', 'recents', 'notifications'] as const;
export type NavAction = (typeof NAV_ACTIONS)[number];
export const CAPTURE_PATHS = ['dda', 'gdi', 'projection'] as const;
export type CapturePath = (typeof CAPTURE_PATHS)[number];

/** Phase C section 2.2: agent build platforms and architectures of `manifest.json`. */
export const AGENT_PLATFORMS = ['windows', 'android'] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];
export const AGENT_ARCHES = ['x64', 'arm64', 'universal'] as const;
export type AgentArch = (typeof AGENT_ARCHES)[number];
/** `desk.hello.client.platform.arch` (section 3.1). */
export const NATIVE_ARCHES = ['x64', 'arm64', 'x86', 'other'] as const;
export type NativeArch = (typeof NATIVE_ARCHES)[number];
/** `agent.stats.rung` (section 4.3). */
export const ABR_RUNGS = ['full', 'high', 'medium', 'low', 'floor'] as const;
export type AbrRung = (typeof ABR_RUNGS)[number];
/** Who ran a playbook (`pb.end.ranAs`, section 8.4). */
export const PLAYBOOK_RAN_AS = ['user', 'admin'] as const;
export type PlaybookRanAs = (typeof PLAYBOOK_RAN_AS)[number];
