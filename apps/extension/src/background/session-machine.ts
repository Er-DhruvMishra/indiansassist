/**
 * The Desk session state machine of the extension (sections 2.4, 3, 9.2): `idle -> have_token -> connecting ->
 * waiting -> held -> knocked -> consent_pending -> active -> ended`. Owns the `/signal` socket, `desk.poll`,
 * the consent window, the attestation outbox and the policy; `LiveSession` owns everything that exists only while
 * `active`. State is mirrored to `chrome.storage.session['ia.session']` so a worker restart resumes.
 */
import {
  DEFAULT_EXTENSION_POLICY,
  LIMITS,
  normaliseTokenInput,
  type ClientSignalMessage,
  type ConsentLevel,
  type JoinReply,
  type SessionEnded,
} from '@indiansassist/shared';
import type { FetchLike } from '../shared/api';
import { ext } from '../shared/api';
import { DEFAULT_API_ORIGIN, LIVE_PHASES, isRegionOrigin, type ExtensionPhase } from '../shared/constants';
import {
  LOCAL_KEYS,
  SESSION_KEYS,
  emptyCounters,
  emptyLog,
  readLocal,
  readManaged,
  readSession,
  removeSession,
  writeLocal,
  writeSession,
  type PersistedSession,
  type PolicyCache,
} from '../shared/storage';
import type { ConsentInfo, Receipt } from '../shared/ui-state';
import type { OutboxEntry } from './attest-outbox';
import { AttestOutbox } from './attest-outbox';
import { applyBadge } from './badge';
import { deskClient } from './client-info';
import { startKeepalive, stopKeepalive } from './keepalive';
import { OffscreenClient } from './offscreen-client';
import { effectivePolicy, type EffectivePolicy } from './policy';
import { PromptManager } from './prompts';
import { handleServerMessage } from './server-messages';
import { SignalClient } from './signal-client';
import { buildReceipt } from './receipt';
import { resolveJoinCode, type ResolveOk } from './token-check';
import { UiHub } from './ui-hub';
import type { LiveSession } from './live-session';

export type MachineDeps = {
  extensionId: string;
  WebSocketImpl?: typeof WebSocket;
  fetch?: FetchLike;
  now?: () => number;
  /** Test hook: replaces `chrome.windows.create` for the consent / popup windows. */
  openWindow?: (url: string, width: number, height: number) => Promise<number | null>;
};

/** How long the Desk waits for the server's `session.ended` after a local end (Phase A prd-F1). */
export const LOCAL_END_FALLBACK_MS = 5000;

export class SessionMachine {
  s: PersistedSession | null = null;
  eff: EffectivePolicy | null = null;
  signal: SignalClient | null = null;
  live: LiveSession | null = null;
  receipt: Receipt | null = null;
  readonly ui = new UiHub();
  readonly offscreen = new OffscreenClient();
  readonly prompts: PromptManager;
  readonly outbox: AttestOutbox;
  /** A `session.created` with state `active` arrived on resume: the next `ice.refresh` rebuilds the PC (Y23). */
  expectRebuild = false;
  levelWaiters: ((ok: boolean) => void)[] = [];
  consentWindowId: number | null = null;
  popupWindowId: number | null = null;
  endPending: ClientSignalMessage | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  endFallback: ReturnType<typeof setTimeout> | null = null;
  private persistQueued = false;
  liveFactory: ((m: SessionMachine) => LiveSession) | null = null;
  consentInfo: ConsentInfo | null = null;

  constructor(readonly deps: MachineDeps) {
    this.prompts = new PromptManager((prompts) => this.ui.set({ prompts }));
    this.outbox = new AttestOutbox({
      send: (frame) => this.signal?.send(frame) ?? false,
      persist: (entries) => writeSession(SESSION_KEYS.outbox, entries).catch(() => undefined),
      now: deps.now,
    });
  }

  get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get phase(): ExtensionPhase {
    return this.s?.phase ?? (this.receipt ? 'ended' : 'idle');
  }

  get isLive(): boolean {
    return LIVE_PHASES.includes(this.phase);
  }

  // ---------- persistence ----------

  /** Writes `ia.session` (coalesced) and refreshes the UI and the badge. */
  persist(): void {
    this.refreshUi();
    if (this.persistQueued) return;
    this.persistQueued = true;
    queueMicrotask(() => {
      this.persistQueued = false;
      if (this.s) void writeSession(SESSION_KEYS.session, this.s).catch(() => undefined);
    });
  }

  setPhase(phase: ExtensionPhase): void {
    if (!this.s) return;
    this.s.phase = phase;
    this.persist();
    this.syncPoll();
  }

  refreshUi(): void {
    const s = this.s;
    this.ui.set({
      phase: this.phase,
      token: s ? { tier: s.tier ?? 'p2_extension', technician: s.technician, org: s.org?.displayName ?? '' } : null,
      session: this.live?.uiSession() ?? null,
      consent: s?.phase === 'consent_pending' ? (this.consentInfo ?? null) : null,
      receipt: this.receipt,
    });
    void applyBadge({
      phase: this.phase,
      technician: s?.assist?.name ?? s?.technician ?? null,
      debuggerAttached: (this.live?.debuggerControl.attached.size ?? 0) > 0,
      backstageCount: this.live?.backstageCount() ?? 0,
    });
  }

  // ---------- startup / restore ----------

  /** Worker start: resume a live session from `storage.session` (section 3.5) or stay idle. */
  async restore(): Promise<void> {
    const s = await readSession<PersistedSession>(SESSION_KEYS.session);
    if (!s || s.endedLocally || !LIVE_PHASES.includes(s.phase)) {
      if (s) await this.clearStorage();
      this.refreshUi();
      return;
    }
    this.s = s;
    const cache = await readSession<PolicyCache>(SESSION_KEYS.policyCache);
    if (cache) this.eff = effectivePolicy(cache.policy, await readManaged());
    this.outbox.restore((await readSession<OutboxEntry[]>(SESSION_KEYS.outbox)) ?? []);
    if (s.phase === 'active' && this.liveFactory) {
      this.live = this.liveFactory(this);
      await this.live.restore();
    }
    this.startSignal();
  }

  // ---------- token entry ----------

  /** Carrier A / B join handshake (section 2.2). */
  async join(code: string, apiOrigin: string): Promise<JoinReply> {
    if (this.isLive) return normaliseTokenInput(code)?.value === this.s?.code ? { ok: true, state: 'already_connected' } : { ok: false, error: 'busy' };
    const r = await resolveJoinCode(code, apiOrigin, { fetch: this.deps.fetch, now: this.deps.now });
    if (!r.ok) {
      this.ui.set({ lastError: { code: r.error, message: r.message } });
      return { ok: false, error: r.error };
    }
    if (this.isLive) return { ok: false, error: 'busy' };
    await this.begin(r, 'join');
    void this.openPopupIfNoPanel();
    return { ok: true, state: 'connecting' };
  }

  /** Side panel paste / manual entry (section 2.3). */
  async connect(code: string, via: 'clipboard' | 'manual', deskLabel?: string): Promise<void> {
    if (this.isLive) return this.ui.set({ lastError: { code: 'busy', message: 'Finish the current session first.' } });
    const managed = await readManaged();
    const stored = await readLocal<string>(LOCAL_KEYS.apiOrigin);
    const apiOrigin = [managed.apiOrigin, stored, DEFAULT_API_ORIGIN].find((o) => isRegionOrigin(o)) ?? DEFAULT_API_ORIGIN;
    this.ui.set({ lastError: null, status: 'Checking the code...' });
    const r = await resolveJoinCode(code, apiOrigin, { fetch: this.deps.fetch, now: this.deps.now });
    if (!r.ok) return this.ui.set({ status: null, lastError: { code: r.error, message: r.message } });
    await this.begin(r, via, deskLabel);
  }

  private async begin(r: ResolveOk, via: 'join' | 'clipboard' | 'manual', deskLabel?: string): Promise<void> {
    const managed = await readManaged();
    if (deskLabel) await writeLocal(LOCAL_KEYS.lastDeskLabel, deskLabel.slice(0, 80));
    const label = deskLabel ?? (await readLocal<string>(LOCAL_KEYS.lastDeskLabel)) ?? managed.deskLabel ?? null;
    this.receipt = null;
    this.s = {
      phase: 'have_token',
      code: r.code,
      signalUrl: r.token.signalUrl,
      apiOrigin: r.apiOrigin,
      tokenId: r.token.tokenId,
      tier: r.token.tier,
      sessionId: null,
      resumeKey: null,
      consent: null,
      technician: r.token.technician?.name ?? null,
      assist: null,
      org: { displayName: r.token.org.displayName, logoData: r.token.org.logoData, accentColor: r.token.org.accentColor },
      orgId: null,
      startedAt: null,
      deskLabel: label,
      consentTabId: null,
      focusedTabId: null,
      tabs: {},
      counters: emptyCounters(),
      log: emptyLog(),
      inputModes: {},
      recording: false,
      relayed: false,
      endedLocally: false,
    };
    await writeSession(SESSION_KEYS.pending, { code: r.code, apiOrigin: r.apiOrigin, via, receivedAt: this.now });
    this.ui.set({ lastError: null, status: null, chat: [], files: [] });
    this.persist();
    this.startSignal();
  }

  // ---------- signaling ----------

  startSignal(): void {
    const s = this.s;
    if (!s) return;
    this.signal?.close();
    if (s.phase === 'have_token') this.setPhase('connecting');
    this.signal = new SignalClient(
      s.signalUrl,
      {
        onOpen: () => this.hello(),
        onMessage: (m) => void handleServerMessage(this, m),
        onClose: (code, terminal) => this.onSocketClosed(code, terminal),
      },
      this.deps.WebSocketImpl,
    );
    this.signal.connect();
    void startKeepalive();
    this.syncPoll();
  }

  private hello(): void {
    const s = this.s;
    if (!s) return;
    this.signal?.send({
      t: 'desk.hello',
      token: s.code,
      ...(s.deskLabel ? { deskLabel: s.deskLabel } : {}),
      ...(s.resumeKey ? { resumeKey: s.resumeKey } : {}),
      client: deskClient(),
    });
  }

  send(msg: ClientSignalMessage): boolean {
    return this.signal?.send(msg) ?? false;
  }

  private syncPoll(): void {
    const want = this.phase === 'waiting' || this.phase === 'held';
    if (want && !this.pollTimer)
      this.pollTimer = setInterval(() => {
        if (this.phase === 'waiting' || this.phase === 'held') this.send({ t: 'desk.poll' });
      }, LIMITS.deskPollIntervalSec * 1000);
    if (!want && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private onSocketClosed(code: number, terminal: boolean): void {
    if (!terminal || !this.s) return;
    if (this.s.endedLocally || code === 4410) void this.finish(null, this.s.endedLocally ? undefined : 'error');
    else void this.fail({ code: 'closed', message: `The connection was closed (${code}).` });
  }

  /** A fatal error (bad token, join refused): local teardown, back to idle with the error shown. */
  async fail(err: { code: string; message: string }): Promise<void> {
    await this.live?.teardown('error');
    this.live = null;
    this.signal?.close();
    this.signal = null;
    this.s = null;
    await this.clearStorage();
    this.ui.set({ lastError: err, status: null, prompts: [] });
    this.syncPoll();
    this.refreshUi();
  }

  // ---------- policy ----------

  async setPolicy(policy = DEFAULT_EXTENSION_POLICY, orgId: string | null): Promise<void> {
    this.eff = effectivePolicy({ ...policy }, await readManaged());
    await writeSession(SESSION_KEYS.policyCache, { orgId: orgId ?? 'unknown', fetchedAt: this.now, policy });
  }

  level(): ConsentLevel {
    return this.s?.consent?.level ?? 'view';
  }

  // ---------- end ----------

  /** Session over (server `session.ended`, or the local fallback): receipt, storage cleared, phase `ended`. */
  async finish(ended: SessionEnded | null, reason?: string): Promise<void> {
    if (this.endFallback) clearTimeout(this.endFallback);
    this.endFallback = null;
    const s = this.s;
    this.prompts.cancelAll();
    await this.live?.teardown('end');
    this.live = null;
    this.signal?.close();
    this.signal = null;
    this.outbox.clear();
    if (s?.sessionId) this.receipt = buildReceipt(s, ended, reason ?? 'desk_stopped', this.now);
    this.s = null;
    await this.clearStorage();
    await stopKeepalive().catch(() => undefined);
    this.syncPoll();
    this.ui.set({ prompts: [], status: null });
    this.refreshUi();
  }

  async clearStorage(): Promise<void> {
    await removeSession(SESSION_KEYS.session, SESSION_KEYS.pending, SESSION_KEYS.outbox, SESSION_KEYS.policyCache).catch(() => undefined);
  }

  dismissEnded(): void {
    if (this.s) return;
    this.receipt = null;
    this.ui.set({ receipt: null, chat: [], files: [], lastError: null });
    this.refreshUi();
  }

  // ---------- windows ----------

  async openWindow(url: string, width: number, height: number): Promise<number | null> {
    if (this.deps.openWindow) return this.deps.openWindow(url, width, height);
    try {
      const w = await ext().windows.create({ url, type: 'popup', width, height, focused: true });
      return w?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Section 9.6: the popup opens only when no side panel is open for the Desk's window. */
  private async openPopupIfNoPanel(): Promise<void> {
    const rt = ext().runtime as typeof chrome.runtime & { getContexts?: (f: object) => Promise<unknown[]> };
    let hasPanel = this.ui.panelWindows().length > 0;
    if (typeof rt.getContexts === 'function') {
      try {
        hasPanel = (await rt.getContexts({ contextTypes: ['SIDE_PANEL'] })).length > 0;
      } catch {
        /* keep the port fallback */
      }
    }
    if (!hasPanel) this.popupWindowId = await this.openWindow('popup.html', 420, 640);
  }
}
