/**
 * Everything that exists only while a P2 session is `active` (sections 3-8): the offscreen peer connection, the
 * capture scripts and tab registry, control handling (it is the `ControlHost`), reveals, backstage, chat and the
 * indicators. Tab events and the `mirror.tabs` feed live in live-tabs.ts; teardown in live-teardown.ts.
 */
import {
  dataChannelMessageSchema,
  levelAtLeast,
  type ConsentLevel,
  type ClientSignalMessage,
  type ControlEvent,
  type ControlResponse,
  type DeskEventAction,
  type InputKind,
  type InputMode,
  type MirrorScope,
} from '@indiansassist/shared';
import { sendToTab } from '../shared/bus';
import type { BarState } from '../shared/bus-schemas';
import type { TabState } from '../shared/storage';
import type { ChatLine, UiSession } from '../shared/ui-state';
import { ContentRegistry } from './content-registry';
import { ControlHandler } from './control-handler';
import type { ControlHost } from './control-ops';
import { DebuggerControl } from './debugger-control';
import { FaviconCache } from './favicons';
import type { GateContext } from './gate';
import type { IceServer } from './ice';
import { LiveTabs } from './live-tabs';
import { teardownLive } from './live-teardown';
import { capturePolicy, type EffectivePolicy } from './policy';
import { isListedFor } from './tab-registry';
import { InputAggregator } from './rate';
import type { SessionMachine } from './session-machine';
import type { TabsDeps } from './tabs-control';

export class LiveSession implements ControlHost {
  readonly control: ControlHandler;
  readonly debuggerControl: DebuggerControl;
  readonly registry: ContentRegistry;
  readonly favicons = new FaviconCache();
  readonly inputs: InputAggregator;
  readonly tabs: LiveTabs;
  transport: 'dc' | 'relay' = 'dc';
  iceServers: IceServer[] = [];
  tabCounters = new Map<number, { bytes: number; batches: number }>();
  openChannels = new Set<string>();
  private chatLines: ChatLine[] = [];
  private toastShown = false;

  constructor(readonly m: SessionMachine) {
    this.tabs = new LiveTabs(this);
    this.debuggerControl = new DebuggerControl((tabId, attached, cause) => {
      this.send({ t: 'ctl.event', kind: 'debugger', tabId, attached, ...(attached ? {} : { cause }), ts: Date.now() });
      if (!attached) this.setInputMode(tabId, 'dom');
      this.s.debuggerTabs = [...this.debuggerControl.attached];
      void this.tabs.updateBar(tabId, { debuggerAttached: attached });
      this.m.persist();
    });
    this.registry = new ContentRegistry({
      onInjectFailed: (tabId) => void this.tabs.injectFailed(tabId),
      sendStop: async (tabId) => void (await sendToTab(tabId, { t: 'cs.stop' })),
    });
    this.inputs = new InputAggregator((data) => this.attest('control.input', data));
    this.control = new ControlHandler(this);
  }

  get s() {
    return this.m.s!;
  }

  // ---------- lifecycle ----------

  /** `consent.ok` (or a rebuild): offscreen document, peer connection, capture, `mirror.started`. */
  async start(iceServers: IceServer[], restart: boolean): Promise<void> {
    this.iceServers = iceServers;
    await this.m.offscreen.ensure();
    await this.m.offscreen.send({ t: 'relay.policy', allowed: this.eff().policy.allowRelayFallback });
    await this.m.offscreen.send({ t: 'pc.create', iceServers, restart, relayAllowed: this.eff().policy.allowRelayFallback });
    await this.tabs.initialise();
    const consent = this.s.consent!;
    this.attest('mirror.started', { reason: 'consent', scope: consent.scope, level: consent.level, tabCount: this.tabs.mirroredIds().length });
    this.m.persist();
  }

  /**
   * Worker restart during `active`: registry, capture registration and debugger attachments rebuilt from
   * `ia.session` (Chrome keeps both the registered script and the debugger attachment across a worker restart, so
   * teardown and level changes must still see them), then the indicators re-applied.
   */
  async restore(): Promise<void> {
    for (const [id, st] of Object.entries(this.s.tabs)) if (st.injected) this.registry.ready(Number(id));
    if (this.s.captureRegistered) this.registry.restoreRegistered();
    const dbg = new Set(this.s.debuggerTabs ?? []);
    for (const [id, mode] of Object.entries(this.s.inputModes)) if (mode === 'debugger') dbg.add(Number(id));
    this.debuggerControl.restore([...dbg]);
    if (!levelAtLeast(this.level(), 'deep_control')) await this.debuggerControl.detachAll('level');
    await this.tabs.reapplyBars();
  }

  /** Section 3.5: never reuse a PC across a resume; brand-new PC, `restart: true` offer, fresh snapshots. */
  async rebuild(iceServers: IceServer[]): Promise<void> {
    this.iceServers = iceServers;
    await this.m.offscreen.ensure();
    // The new PC re-creates the channels; the old ones close without a dc.close (F7), so nothing is open now.
    this.openChannels.clear();
    await this.m.offscreen.send({ t: 'pc.create', iceServers, restart: true, relayAllowed: this.eff().policy.allowRelayFallback });
    const consent = this.s.consent!;
    this.attest('mirror.started', { reason: 'reconnect', scope: consent.scope, level: consent.level, tabCount: this.tabs.mirroredIds().length });
  }

  async teardown(kind: 'end' | 'error'): Promise<void> {
    this.finishing = true;
    await teardownLive(this, kind === 'end' ? 'ended' : 'error', true, undefined, false);
  }

  // ---------- ControlHost ----------

  sessionId(): string {
    return this.s.sessionId ?? '';
  }
  technician(): string {
    return this.s.assist?.name ?? this.s.technician ?? 'Your technician';
  }
  level(): ConsentLevel {
    return this.s.consent?.level ?? 'view';
  }
  scope(): MirrorScope {
    return this.s.consent?.scope ?? 'current_tab';
  }
  eff(): EffectivePolicy {
    return this.m.eff!;
  }
  gateContext(): GateContext {
    return {
      level: this.level(),
      backstageConsent: this.s.consent?.backstage === true,
      backstageAllowed: this.eff().backstageAllowed,
      tab: (id) => this.tabState(id),
    };
  }
  tabState(tabId: number): TabState | undefined {
    return this.s.tabs[String(tabId)];
  }
  get tabsDeps(): TabsDeps {
    return {
      denyList: () => this.eff().denyList,
      info: (tab) => this.tabs.info(tab),
      onCreated: (tab, backstage) => this.tabs.assistCreated(tab, backstage),
      listed: (tabId) => isListedFor(this.tabState(tabId), this.scope()),
    };
  }
  send(msg: ControlResponse | ControlEvent): void {
    void this.m.offscreen.send({ t: 'dc.send', label: 'ia.control', msg: msg as unknown as Record<string, unknown> });
  }
  attest(action: DeskEventAction, data: Record<string, unknown>, reason?: string): void {
    if (this.s.sessionId) this.m.outbox.enqueue(this.s.sessionId, action, data, reason);
  }
  recordInput(tabId: number, kind: InputKind, refused: boolean, mode?: InputMode): void {
    this.inputs.record(tabId, mode ?? this.inputMode(tabId), kind, refused);
    if (!refused) this.s.counters.inputs++;
  }
  countTabAction(): void {
    this.s.counters.tabActions++;
  }
  listTabs(): Promise<Record<string, unknown>> {
    return this.tabs.list();
  }
  queryTabs(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.tabs.query(args);
  }
  focus(tabId: number): Promise<void> {
    return this.tabs.focus(tabId);
  }
  async snapshot(tabId: number): Promise<void> {
    await this.m.offscreen.send({ t: 'mirror.snapshot', tabId });
  }
  attachTab(tabId: number): Promise<void> {
    return this.tabs.attach(tabId);
  }
  contentRequest<T>(tabId: number, msg: { t: string } & Record<string, unknown>): Promise<T | undefined> {
    return sendToTab<T>(tabId, msg);
  }
  inputMode(tabId: number): InputMode {
    return this.s.inputModes[String(tabId)] ?? 'dom';
  }
  setInputMode(tabId: number, mode: InputMode): void {
    if (mode === 'dom') delete this.s.inputModes[String(tabId)];
    else this.s.inputModes[String(tabId)] = mode;
  }
  get prompts() {
    return this.m.prompts;
  }
  recording(): boolean {
    return this.s.recording;
  }
  /** Correlated by frame id: only the `consent.level_ok` / `error` whose `re` is this frame resolves it (F11). */
  requestLevel(level: ConsentLevel, opId: string): Promise<boolean> {
    const id = this.m.nextLevelFrameId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.m.resolveLevel(id, false), 10000);
      this.m.levelWaiters.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      if (!this.m.send({ t: 'desk.consent_level', id, sessionId: this.sessionId(), level, requested: true, opId })) this.m.resolveLevel(id, false);
    });
  }
  revealGranted(tabId: number, scope: 'field' | 'tab', reason?: string, fieldKind?: string): void {
    this.tabs.revealGranted(tabId, scope, reason ?? '', fieldKind);
  }
  backstageEntered(tabId: number, url: string, opId: string): void {
    this.tabs.backstageEntered(tabId, url, opId);
    if (!this.toastShown) {
      this.toastShown = true;
      void this.tabs.toast(tabId, url);
    }
  }
  backstageExit(tabId: number, action: 'close' | 'keep' | 'bring_to_front', opId: string): Promise<void> {
    return this.tabs.backstageExit(tabId, action, opId);
  }
  showBarPrompt(tabId: number | null, id: string, text: string, panelOnly?: boolean): void {
    void this.tabs.barPrompt(tabId, id, text, panelOnly);
  }
  clearBarPrompt(id: string): void {
    void this.tabs.clearBarPrompt(id);
  }

  // ---------- consent changes ----------

  /** `consent.level_ok`: the server recorded a level change. */
  levelConfirmed(level: ConsentLevel, backstage: boolean): void {
    const c = this.s.consent;
    if (!c) return;
    const from = c.level;
    if (from !== level) this.s.log.levelChanges.push({ from, to: level, at: new Date().toISOString(), requestedBy: this.pendingDeskLevel === level ? 'desk' : 'assist' });
    this.pendingDeskLevel = null;
    void this.applyLevel(level);
    c.backstage = backstage && this.eff().backstageAllowed;
    this.sendLevelEvent();
    this.m.persist();
  }

  pendingDeskLevel: ConsentLevel | null = null;

  /** Applies a (lower) level locally before the WS frame (section 3.2 "Desk lowers"). */
  async applyLevel(level: ConsentLevel): Promise<void> {
    const c = this.s.consent;
    if (!c) return;
    c.level = level;
    if (!levelAtLeast(level, 'deep_control')) await this.debuggerControl.detachAll('level');
    await this.tabs.levelChanged(level);
  }

  sendLevelEvent(): void {
    const c = this.s.consent;
    if (c) this.send({ t: 'ctl.event', kind: 'level', level: c.level, scope: c.scope, backstage: c.backstage, ts: Date.now() });
  }

  setRecording(on: boolean): void {
    this.s.recording = on;
    if (on) this.s.log.recordingSeen = true;
    void this.tabs.updateAllBars({ recording: on });
    this.m.persist();
  }

  // ---------- data channels ----------

  /** A message the offscreen document received on a data channel (validated here by label). */
  async onChannelMessage(label: string, raw: unknown): Promise<void> {
    if (label === 'ia.control') return this.control.handle(raw);
    const parsed = dataChannelMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (label === 'ia.chat' && msg.t === 'chat' && msg.from === 'assist') {
      this.receiveChat({ msgId: msg.msgId, from: 'assist', text: msg.text, ts: msg.ts });
      await this.m.offscreen.send({ t: 'dc.send', label: 'ia.chat', msg: { t: 'chat.ack', msgId: msg.msgId, ts: Date.now() } }); // A section 8.1
    } else if (label === 'ia.ctrl' && msg.t === 'recording.state') this.setRecording(msg.recording);
    else if (label === 'ia.ctrl' && msg.t === 'voice.state') this.m.ui.broadcast({ t: 'peerVoice', muted: msg.muted });
    else if (label === 'ia.annot' && msg.t === 'annot') await this.tabs.annotate(raw as Record<string, unknown>);
  }

  onChannelOpen(label: string): void {
    this.openChannels.add(label);
    if (label === 'ia.control') this.sendLevelEvent();
    if (label === 'ia.mirror') this.tabs.scheduleTabsPush();
  }

  receiveChat(line: ChatLine): void {
    if (this.chatLines.some((l) => l.msgId === line.msgId)) return;
    this.chatLines = [...this.chatLines, line].slice(-200);
    this.m.ui.set({ chat: this.chatLines });
    this.m.ui.broadcast({ t: 'chat', msg: line });
  }

  async sendChat(text: string): Promise<void> {
    const line: ChatLine = { msgId: crypto.randomUUID(), from: 'desk', text, ts: Date.now() };
    this.receiveChat(line);
    if (this.openChannels.has('ia.chat')) {
      const r = await this.m.offscreen.send<{ ok?: boolean }>({ t: 'dc.send', label: 'ia.chat', msg: { t: 'chat', ...line } });
      if (r?.ok !== false) return;
      this.openChannels.delete('ia.chat'); // the channel is gone (rebuild): fall back to the WS
    }
    this.m.send({ t: 'chat.message', sessionId: this.sessionId(), ...line } as unknown as ClientSignalMessage);
  }

  // ---------- indicators and UI ----------

  backstageCount(): number {
    return Object.values(this.s.tabs).filter((t) => t.backstage).length;
  }

  barFor(tabId: number): BarState {
    const st = this.tabState(tabId);
    return {
      technician: this.technician(),
      org: this.s.org?.displayName ?? '',
      relayed: this.transport === 'relay',
      recording: this.s.recording,
      debuggerAttached: this.debuggerControl.attached.has(tabId),
      backstage: st?.backstage ?? false,
      backstageCount: this.backstageCount(),
      paused: st?.paused ?? false,
      revealed: st?.reveal !== undefined,
    };
  }

  capturePolicy() {
    return capturePolicy(this.eff());
  }

  uiSession(): UiSession {
    const c = this.s.consent!;
    const reveals: UiSession['reveals'] = {};
    for (const [id, st] of Object.entries(this.s.tabs)) if (st.reveal) reveals[id] = { scope: st.reveal.scope, until: st.reveal.until };
    return {
      sessionId: this.sessionId(),
      assist: this.technician(),
      level: c.level,
      maxLevel: this.eff().maxLevel,
      scope: c.scope,
      backstage: c.backstage,
      backstageAllowed: this.eff().backstageAllowed,
      startedAt: this.s.startedAt,
      transport: this.transport,
      recording: this.s.recording,
      tabs: this.tabs.lastInfos,
      backstageCount: this.backstageCount(),
      debuggerTabs: [...this.debuggerControl.attached],
      reveals,
      protectedCount: Object.values(this.s.tabs).filter((t) => t.mirrored === 'denied').length,
      finishing: this.finishing,
    };
  }

  finishing = false;
}
