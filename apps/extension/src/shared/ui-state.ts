/**
 * The state the service worker pushes to every UI page over the `ia.ui` Port (section 9.3 `UiState`), the P2
 * receipt (section 7) and the prompt cards (sections 3.2, 5.3, 8.4).
 */
import type { ConsentLevel, MirrorScope, MirrorTransport, TabInfo } from '@indiansassist/shared';
import type { ExtensionPhase } from './constants';

export type ChatLine = { msgId: string; from: 'assist' | 'desk'; text: string; ts: number };

export type FileRow = {
  key: string;
  outgoing: boolean;
  fileId: number;
  name: string;
  size: number;
  mime: string;
  status: 'hashing' | 'offered' | 'transferring' | 'verifying' | 'done' | 'rejected' | 'cancelled' | 'failed';
  bytesDone: number;
  executable: boolean;
  sniffed?: string;
  blobUrl?: string;
  error?: string;
};

export type PromptKind = 'level' | 'mask' | 'attach';

export type UiPrompt = {
  id: string;
  promptKind: PromptKind;
  technician: string;
  reason: string | null;
  /** level prompts: the requested level; mask prompts: the field label; attach prompts: the tab title. */
  label: string | null;
  host: string | null;
  level: ConsentLevel | null;
  recording: boolean;
  recordRevealed: boolean;
  expiresAt: number;
};

export type Receipt = {
  sessionId: string;
  org: string;
  technician: string;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
  endReason: string;
  surface: 'browser';
  recordingSeen: boolean;
  hashChainTail: string | null;
  tabsShared: { host: string; from: string; to: string | null }[];
  levelChanges: { from: ConsentLevel; to: ConsentLevel; at: string; requestedBy: 'assist' | 'desk' }[];
  unmasks: { host: string; scope: 'field' | 'tab'; fieldKind?: string; reason: string; durationMs: number }[];
  backstage: { host: string; outcome: string }[];
  tabActions: number;
  inputs: number;
  relayed: boolean;
};

/** What the consent window needs while `consent_pending` (section 3.1). */
export type ConsentInfo = {
  sessionId: string;
  technician: string;
  org: { displayName: string; logoData: string | null };
  maxLevel: ConsentLevel;
  defaultLevel: ConsentLevel;
  allowAllTabs: boolean;
  backstageAllowed: boolean;
  managedLimited: boolean;
  denyHosts: string[];
  candidateTabId: number | null;
};

export type UiSession = {
  sessionId: string;
  assist: string;
  level: ConsentLevel;
  maxLevel: ConsentLevel;
  scope: MirrorScope;
  backstage: boolean;
  backstageAllowed: boolean;
  startedAt: number | null;
  transport: MirrorTransport;
  recording: boolean;
  tabs: TabInfo[];
  backstageCount: number;
  debuggerTabs: number[];
  reveals: Record<string, { scope: 'field' | 'tab'; until: number }>;
  protectedCount: number;
  finishing: boolean;
};

export type UiState = {
  phase: ExtensionPhase;
  token: { tier: string; technician: string | null; org: string } | null;
  status: string | null;
  session: UiSession | null;
  consent: ConsentInfo | null;
  prompts: UiPrompt[];
  chat: ChatLine[];
  files: FileRow[];
  voice: { muted: boolean; available: boolean };
  receipt: Receipt | null;
  lastError: { code: string; message: string } | null;
};

export const INITIAL_UI_STATE: UiState = {
  phase: 'idle',
  token: null,
  status: null,
  session: null,
  consent: null,
  prompts: [],
  chat: [],
  files: [],
  voice: { muted: true, available: true },
  receipt: null,
  lastError: null,
};

export const LEVEL_LABELS: Record<ConsentLevel, string> = {
  view: 'View only',
  tab_control: 'Switch and open tabs',
  in_page: 'Click and type in shared pages',
  deep_control: 'Deep control',
};
