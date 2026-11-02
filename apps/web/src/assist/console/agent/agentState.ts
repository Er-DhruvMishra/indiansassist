/** Snapshot of the P3 console (docs/specs/phase-c-contracts.md section 13.4) and its pure derived rules. */
import {
  agentLevelAtLeast,
  consentLevelFamily,
  isAgentConsentLevel,
  type AgentCapabilities,
  type AgentConsentLevel,
  type AgentStats,
  type ElevationLevel,
  type MonitorInfo,
  type PackageTier,
  type PbEnd,
  type PlaybookManifest,
  type SessionCreated,
  type SessionEnded,
} from '@indiansassist/shared';
import type { Transfer } from '../../../lib/fileTransfer';
import type { ChatItem } from '../../../lib/link';
import { EMPTY_STATS, type NetStats } from '../../../lib/stats';

export type AgentPhase = 'resuming' | 'waiting_consent' | 'connecting' | 'securing' | 'live' | 'ending' | 'ended';
export type SecState = 'idle' | 'securing' | 'established' | 'failed';
export type ElevationUiState = 'requesting' | 'prompt_shown' | 'uac_shown' | 'handover' | 'denied' | 'failed' | 'granted';

export type PlaybookRun = {
  runId: string;
  playbookId: string;
  name: string;
  stdout: string;
  stderr: string;
  end: PbEnd | null;
  /** The op answer (`accepted` or the agent's refusal code). */
  opError: string | null;
};

export type AgentSnapshot = {
  phase: AgentPhase;
  created: SessionCreated | null;
  capabilities: AgentCapabilities | null;
  sec: { state: SecState; gen: number; sas: string | null; failReason: string | null };
  /** Every security code of the session by key generation (section 1.3 step 7). */
  sasHistory: { gen: number; sas: string }[];
  /** The generation whose code the technician confirmed (or skipped); null = not yet. */
  sasConfirmedGen: number | null;
  requireSasConfirm: boolean;
  /** Show the confirmation modal (after every rebuild once a code was confirmed, or on a Control click). */
  sasPrompt: boolean;
  /** Read from `consent.changed` only (B rule); `agentLevel` mirrors `ctl.event agent_level`. */
  consent: { level: AgentConsentLevel | null; monitors: number | null; clipboard: boolean };
  agentLevel: { level: AgentConsentLevel; clipboard: boolean; elevation: ElevationLevel } | null;
  /** The console's own input mode: input ops are sent only in `control`. */
  inputMode: 'view' | 'control';
  monitors: MonitorInfo[];
  selected: number[];
  /** The monitor the technician looks at, or `all` for the mosaic. */
  viewed: number | 'all';
  /** Remote video streams by SDP mid (section 3.6 M1). */
  streams: Record<string, MediaStream>;
  remoteAudio: MediaStream | null;
  clipboardSync: boolean;
  clipboardReceived: string | null;
  elevation: { opId: string; state: ElevationUiState; cause?: string } | null;
  playbooks: PlaybookManifest[];
  playbooksTruncated: boolean;
  runs: PlaybookRun[];
  agentStats: AgentStats | null;
  net: NetStats;
  glassMs: number | null;
  captureNotice: string | null;
  /** Phase F section 3.4b: the last `ctl.event keep` value of the session (null: none received). Read-only. */
  kept: boolean | null;
  chat: ChatItem[];
  peerTyping: boolean;
  transfers: Transfer[];
  voiceOn: boolean;
  muted: boolean;
  peerMuted: boolean | null;
  ended: SessionEnded | null;
  notice: string | null;
  error: string | null;
};

export const AGENT_INITIAL: AgentSnapshot = {
  phase: 'resuming',
  created: null,
  capabilities: null,
  sec: { state: 'idle', gen: 0, sas: null, failReason: null },
  sasHistory: [],
  sasConfirmedGen: null,
  requireSasConfirm: true,
  sasPrompt: false,
  consent: { level: null, monitors: null, clipboard: false },
  agentLevel: null,
  inputMode: 'view',
  monitors: [],
  selected: [],
  viewed: 1,
  streams: {},
  remoteAudio: null,
  clipboardSync: false,
  clipboardReceived: null,
  elevation: null,
  playbooks: [],
  playbooksTruncated: false,
  runs: [],
  agentStats: null,
  net: EMPTY_STATS,
  glassMs: null,
  captureNotice: null,
  kept: null,
  chat: [],
  peerTyping: false,
  transfers: [],
  voiceOn: false,
  muted: false,
  peerMuted: null,
  ended: null,
  notice: null,
  error: null,
};

/** Family rule (section 3.4): compare only after branching on the tier; a P2 level never reaches the P3 compare. */
export function levelAllows(tier: PackageTier, level: string | null | undefined, wanted: AgentConsentLevel): boolean {
  if (consentLevelFamily(tier) !== 'p3' || !isAgentConsentLevel(level)) return false;
  return agentLevelAtLeast(level, wanted);
}

/** The security code of the current generation is confirmed (or the policy lets the technician skip). */
export function sasOk(s: Pick<AgentSnapshot, 'sec' | 'sasConfirmedGen'>): boolean {
  return s.sec.state === 'established' && s.sasConfirmedGen === s.sec.gen;
}

export function hasFeature(s: Pick<AgentSnapshot, 'capabilities'>, f: AgentCapabilities['features'][number]): boolean {
  return s.capabilities?.features.includes(f) ?? false;
}

/** Why Control is greyed, or null when the technician may switch to Control (section 13.4 InputModeToggle). */
export function controlBlocker(s: AgentSnapshot): string | null {
  const tier = s.created?.tier ?? 'p3_portable';
  if (s.sec.state !== 'established') return 'Securing the connection';
  if (s.capabilities && !hasFeature(s, 'input')) return 'This Desk cannot take remote control';
  if (!levelAllows(tier, s.consent.level, 'control')) return 'The user allows viewing only';
  if (!sasOk(s)) return 'Confirm the security code first';
  return null;
}

/** The chip text: the level, and the integrity when the process is elevated but the level is lower (section 3.4). */
export function levelChip(s: Pick<AgentSnapshot, 'consent' | 'agentLevel'>): string {
  const level = s.consent.level ?? 'view';
  const admin = s.agentLevel?.elevation === 'admin';
  if (level === 'elevated') return 'Elevated';
  if (admin) return `Elevated process (${level === 'control' ? 'control' : 'view only'})`;
  return level === 'control' ? 'Control' : 'View only';
}
