/**
 * Storage keys and typed access (section 9.4). Session state, the pending join, the attestation outbox and the
 * live policy live in `chrome.storage.session` (cleared on browser exit, `TRUSTED_CONTEXTS` only). Only the four
 * local keys may ever reach `chrome.storage.local`: tokens, resume keys, chat text and org policies never do.
 */
import { managedPolicySchema, type ConsentLevel, type ExtensionPolicy, type ManagedPolicy, type MirrorScope } from '@indiansassist/shared';
import type { ExtensionPhase } from './constants';
import { ext } from './api';

export const SESSION_KEYS = {
  session: 'ia.session',
  pending: 'ia.pending',
  outbox: 'ia.outbox',
  policyCache: 'ia.policyCache',
} as const;
export const LOCAL_KEYS = {
  apiOrigin: 'ia.apiOrigin',
  lastDeskLabel: 'ia.lastDeskLabel',
  pubkeys: 'ia.pubkeys',
  diagnostics: 'ia.diagnostics',
} as const;
export type SessionKey = (typeof SESSION_KEYS)[keyof typeof SESSION_KEYS];
export type LocalKey = (typeof LOCAL_KEYS)[keyof typeof LOCAL_KEYS];
const LOCAL_SET = new Set<string>(Object.values(LOCAL_KEYS));
const SESSION_SET = new Set<string>(Object.values(SESSION_KEYS));

export type TabState = {
  mirrored: 'yes' | 'paused' | 'denied' | 'too_large' | 'not_in_scope' | 'unsupported';
  paused: boolean;
  /** Under `current_tab`: the Desk shared this tab (consent, attach) or the Assist created it. */
  inScope: boolean;
  backstage: boolean;
  createdByAssist: boolean;
  enteredAt: number;
  injected: boolean;
  host: string | null;
  error?: 'inject_failed';
  reveal?: { scope: 'field' | 'tab'; until: number; level: ConsentLevel };
  backstageOpId?: string;
};

export type SessionCounters = { batches: number; bytes: number; tabActions: number; inputs: number; relayed: boolean };

/** Local facts for the P2 receipt (section 7 "Session info"); never sent anywhere. */
export type ReceiptLog = {
  tabsShared: { host: string; from: string; to: string | null }[];
  levelChanges: { from: ConsentLevel; to: ConsentLevel; at: string; requestedBy: 'assist' | 'desk' }[];
  unmasks: { host: string; scope: 'field' | 'tab'; fieldKind?: string; reason: string; durationMs: number }[];
  backstage: { host: string; outcome: string }[];
  recordingSeen: boolean;
};

export type PersistedSession = {
  phase: ExtensionPhase;
  code: string;
  signalUrl: string;
  apiOrigin: string;
  tokenId: string | null;
  tier: string | null;
  sessionId: string | null;
  resumeKey: string | null;
  consent: { level: ConsentLevel; scope: MirrorScope; backstage: boolean } | null;
  technician: string | null;
  assist: { id: string; name: string } | null;
  org: { displayName: string; logoData: string | null; accentColor: string | null } | null;
  orgId: string | null;
  startedAt: number | null;
  deskLabel: string | null;
  consentTabId: number | null;
  focusedTabId: number | null;
  tabs: Record<string, TabState>;
  counters: SessionCounters;
  log: ReceiptLog;
  inputModes: Record<string, 'dom' | 'debugger'>;
  recording: boolean;
  relayed: boolean;
  /** The Desk ended the session itself: never resume it, never show consent again. */
  endedLocally: boolean;
};

export function emptyLog(): ReceiptLog {
  return { tabsShared: [], levelChanges: [], unmasks: [], backstage: [], recordingSeen: false };
}

export type PendingJoin = {
  code: string;
  apiOrigin: string;
  via: 'join' | 'clipboard' | 'manual';
  candidateTabId?: number;
  receivedAt: number;
};

export type PolicyCache = { orgId: string; fetchedAt: number; policy: ExtensionPolicy };

export type Diagnostics = {
  lastError: string | null;
  lastSessionId: string | null;
  version: string;
  skippedSelectors: string[];
  originRefusals: number;
};

export async function readSession<T>(key: SessionKey): Promise<T | undefined> {
  const got = await ext().storage.session.get(key);
  return got[key] as T | undefined;
}

export async function writeSession(key: SessionKey, value: unknown): Promise<void> {
  if (!SESSION_SET.has(key)) throw new Error(`not a session storage key: ${String(key)}`);
  await ext().storage.session.set({ [key]: value });
}

export async function removeSession(...keys: SessionKey[]): Promise<void> {
  await ext().storage.session.remove(keys);
}

export async function readLocal<T>(key: LocalKey): Promise<T | undefined> {
  const got = await ext().storage.local.get(key);
  return got[key] as T | undefined;
}

/** Throws for any key outside the four local keys (tokens, policies and chat never reach disk). */
export async function writeLocal(key: LocalKey, value: unknown): Promise<void> {
  if (!LOCAL_SET.has(key)) throw new Error(`not a local storage key: ${String(key)}`);
  await ext().storage.local.set({ [key]: value });
}

export async function removeLocal(...keys: LocalKey[]): Promise<void> {
  await ext().storage.local.remove(keys);
}

/** The Desk employer's managed policy; anything unreadable or invalid reads as no policy. */
export async function readManaged(): Promise<ManagedPolicy> {
  try {
    const raw = await ext().storage.managed.get(null);
    const parsed = managedPolicySchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Content scripts must never read session storage (section 9.4). */
export async function lockSessionStorage(): Promise<void> {
  try {
    await ext().storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' as chrome.storage.AccessLevel });
  } catch {
    /* older browsers: the default is already TRUSTED_CONTEXTS */
  }
}

export async function patchDiagnostics(patch: Partial<Diagnostics>, version: string): Promise<void> {
  const cur = (await readLocal<Diagnostics>(LOCAL_KEYS.diagnostics)) ?? {
    lastError: null,
    lastSessionId: null,
    version,
    skippedSelectors: [],
    originRefusals: 0,
  };
  await writeLocal(LOCAL_KEYS.diagnostics, { ...cur, ...patch, version });
}

export function emptyCounters(): SessionCounters {
  return { batches: 0, bytes: 0, tabActions: 0, inputs: 0, relayed: false };
}
