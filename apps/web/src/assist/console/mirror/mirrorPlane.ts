/**
 * The data plane of a P2 console session (Phase B 4, 5, 8.4, 10): mirror receiver -> sanitised events -> replayer
 * frame (and the optional recorder), `mirror.tabs` / `mirror.tab` -> tab strip state, replayer captures -> `input.*`
 * ops (only in the in-page / deep modes the Desk granted), reveal requests, and every other control op. It owns no
 * transport: the controller passes in how to send acks, `ctl.req` and reports, and it survives link rebuilds.
 */
import {
  LIMITS,
  levelAtLeast,
  dcMirrorTabSchema,
  dcMirrorTabsSchema,
  minLevelFor,
  type ConsentLevel,
  type ControlEvent,
  type ControlOp,
  type ControlRequest,
} from '@indiansassist/shared';
import { ControlClient, type AnyReport, type ControlResult } from './controlClient';
import { forwardsInput, keyArgs, pointerArgs, scrollArgs, type InputMode } from './controlBuilders';
import { MirrorReceiver, type MirrorAckMsg, type RelayFrame } from './mirrorReceiver';
import type { MirrorRecorder } from './mirrorRecorder';
import { EMPTY_TABS, applyTab, applyTabs, markAllWaiting, markLive, setFocus, type TabsState } from './mirrorState';
import { ReplayerBridge, sanitiseEvents } from './replayerBridge';
import type { ArmMode, ReplayerMessage } from './replayerProtocol';

export type OpNotice = { text: string; ok: boolean; at: number };
export type RevealTarget = { tabId: number; scope: 'field' | 'tab'; nodeId?: number };

export type PlaneSnap = {
  tabs: TabsState;
  inputMode: InputMode;
  armed: ArmMode;
  debuggerTabs: number[];
  mask: { masked: number; revealed: number };
  revealUntil: Record<number, number>;
  revealTarget: RevealTarget | null;
  mirrorKbps: number;
  lastOp: OpNotice | null;
  frameHint: boolean;
  promptOpen: 'level' | 'mask' | 'attach' | null;
  unreported: number;
};

export const EMPTY_PLANE: PlaneSnap = {
  tabs: EMPTY_TABS,
  inputMode: 'view',
  armed: 'off',
  debuggerTabs: [],
  mask: { masked: 0, revealed: 0 },
  revealUntil: {},
  revealTarget: null,
  mirrorKbps: 0,
  lastOp: null,
  frameHint: false,
  promptOpen: null,
  unreported: 0,
};

export type PlaneDeps = {
  sessionId: string;
  get: () => PlaneSnap & { level: ConsentLevel | null };
  set: (patch: Partial<PlaneSnap>) => void;
  sendMirror: (m: MirrorAckMsg) => void;
  sendDc: (m: ControlRequest) => boolean;
  sendRelay: (m: ControlRequest) => boolean;
  report: (r: AnyReport) => Promise<unknown>;
  recorder: () => MirrorRecorder | null;
  onFirstSnapshot?: () => void;
  bridge?: ReplayerBridge;
};

const ERROR_TEXT: Record<string, string> = {
  not_allowed: 'Not allowed at the current level.',
  denied_url: 'That site is protected and cannot be opened or controlled.',
  no_such_tab: 'That tab no longer exists.',
  tab_paused: 'The user paused this tab.',
  not_supported: 'Not supported on this tab.',
  not_in_scope: 'That tab is not shared.',
  debugger_unavailable: 'Deep control is not available (the user may have cancelled it).',
  refused: 'The user refused.',
  timeout: 'The user did not answer in time.',
  rate_limited: 'Too many requests; slow down.',
  bad_args: 'Invalid request.',
  internal: 'The request failed.',
};

export function describeError(r: Extract<ControlResult, { ok: false }>): string {
  if (r.code === 'not_supported' && r.message === 'cross-origin frame') return 'This area is an embedded frame and cannot be controlled.';
  return ERROR_TEXT[r.code] ?? r.message;
}

export class MirrorPlane {
  readonly bridge: ReplayerBridge;
  readonly receiver: MirrorReceiver;
  readonly control: ControlClient;
  private offBridge: () => void;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private sawSnapshot = false;
  private readyOnce = false;
  /** Tabs with a `mask.request` in flight (the recorder holds their lines until the answer, Phase B 4.7). */
  private revealAsks = new Set<number>();

  constructor(private readonly deps: PlaneDeps) {
    this.bridge = deps.bridge ?? new ReplayerBridge();
    this.receiver = new MirrorReceiver({
      onSnapshot: (tabId, events) => this.onSnapshot(tabId, events),
      onEvents: (tabId, seq, events) => this.onEvents(tabId, seq, events),
      onJson: (v) => this.mirrorJson(v),
      send: (m) => deps.sendMirror(m),
    });
    this.control = new ControlClient({
      sessionId: deps.sessionId,
      sendDc: deps.sendDc,
      sendRelay: deps.sendRelay,
      report: deps.report,
      onEvent: (e) => this.onControlEvent(e),
      onUnreported: (n) => deps.set({ unreported: n }),
    });
    this.offBridge = this.bridge.on((m) => this.onFrame(m));
  }

  private get snap() {
    return this.deps.get();
  }

  /** Brings a recorder started mid-ask or mid-reveal up to date before it sees the tab's events. */
  private recorderFor(tabId: number): MirrorRecorder | null {
    const rec = this.deps.recorder();
    if (!rec) return null;
    if (this.revealAsks.has(tabId)) rec.ask(tabId);
    const info = this.snap.tabs.tabs.find((t) => t.tabId === tabId);
    if (info && info.revealed !== 'none') rec.revealStart(tabId, info.revealed);
    return rec;
  }

  private onSnapshot(tabId: number, events: unknown[]): void {
    const clean = sanitiseEvents(events);
    const rec = this.recorderFor(tabId);
    for (const e of clean) rec?.event(tabId, 0, e);
    this.bridge.snapshot(tabId, clean);
    if (!this.sawSnapshot) {
      this.sawSnapshot = true;
      this.deps.onFirstSnapshot?.();
    }
  }

  private onEvents(tabId: number, seq: number, events: unknown[]): void {
    const clean = sanitiseEvents(events);
    const rec = this.recorderFor(tabId);
    for (const e of clean) rec?.event(tabId, seq, e);
    this.bridge.events(tabId, clean);
  }

  /** `mirror.tabs` / `mirror.tab`, from `ia.mirror` or a `kind: 'json'` relay frame. */
  mirrorJson(v: unknown): void {
    const tabs = dcMirrorTabsSchema.safeParse(v);
    if (tabs.success) {
      const before = this.snap.tabs.focusedTabId;
      const next = applyTabs(this.snap.tabs, tabs.data);
      this.deps.set({ tabs: next });
      this.deps.recorder()?.meta(tabs.data);
      if (next.focusedTabId !== before && next.focusedTabId !== null) this.bridge.focus(next.focusedTabId);
      return;
    }
    const tab = dcMirrorTabSchema.safeParse(v);
    if (!tab.success) return;
    const m = tab.data;
    const rec = this.deps.recorder();
    rec?.meta(m, m.tab.tabId);
    if (m.state === 'revealed') rec?.revealStart(m.tab.tabId, m.tab.revealed === 'tab' ? 'tab' : 'field');
    if (m.state === 'restored' || m.state === 'detached') {
      const redacted = rec?.revealEnd(m.tab.tabId) ?? false;
      // The masked restore snapshot may have arrived inside the window (and been re-masked): re-sync the recording.
      if (redacted && m.state === 'restored') void this.op('mirror.snapshot', { tabId: m.tab.tabId }, { quiet: true });
      const revealUntil = { ...this.snap.revealUntil };
      delete revealUntil[m.tab.tabId];
      this.deps.set({ revealUntil });
    }
    if (m.state === 'detached') {
      this.receiver.forgetTab(m.tab.tabId);
      this.bridge.reset(m.tab.tabId);
    }
    const before = this.snap.tabs.focusedTabId;
    const next = applyTab(this.snap.tabs, m.tab, m.state, m.transport);
    this.deps.set({ tabs: next });
    if (next.focusedTabId !== before) this.bridge.focus(next.focusedTabId);
  }

  pushBinary(frame: ArrayBuffer): void {
    this.receiver.pushBinary(frame);
  }

  pushRelay(m: RelayFrame): void {
    this.receiver.pushRelay(m);
  }

  /** Once a second: reassembly expiry, periodic acks, the kbps readout and reveal expiry. */
  tick(now = Date.now()): void {
    this.receiver.tick();
    const patch: Partial<PlaneSnap> = { mirrorKbps: this.receiver.kbps() };
    const ru = this.snap.revealUntil;
    if (Object.values(ru).some((t) => t <= now)) patch.revealUntil = Object.fromEntries(Object.entries(ru).filter(([, t]) => t > now));
    this.deps.set(patch);
  }

  /** A new peer connection: keep the replayers and the recorder, wait for fresh snapshots (Phase B 3.5). */
  linkRebuilt(): void {
    this.receiver.expectSnapshots();
    this.deps.set({ tabs: markAllWaiting(this.snap.tabs) });
    this.deps.recorder()?.reconnect();
  }

  // ---------- frame ----------

  attachFrame(frame: HTMLIFrameElement | null): void {
    this.bridge.attach(frame);
  }

  private onFrame(m: ReplayerMessage): void {
    const s = this.snap;
    switch (m.t) {
      case 'rp.ready':
        if (s.tabs.focusedTabId !== null) this.bridge.focus(s.tabs.focusedTabId);
        this.bridge.arm(s.armed === 'off' && forwardsInput(s.inputMode, s.level) ? 'input' : s.armed);
        // A reloaded frame lost its replayers: ask for a fresh snapshot of the focused tab.
        if (this.readyOnce && s.tabs.focusedTabId !== null) void this.op('mirror.snapshot', { tabId: s.tabs.focusedTabId }, { quiet: true });
        this.readyOnce = true;
        return;
      case 'rp.applied':
        if (m.kind === 'snapshot') this.receiver.applied(m.tabId);
        this.deps.set({ tabs: markLive(s.tabs, m.tabId) });
        return;
      case 'rp.maskStats':
        if (m.tabId === s.tabs.focusedTabId) this.deps.set({ mask: { masked: m.masked, revealed: m.revealed } });
        return;
      case 'rp.pointer':
        if (s.armed === 'reveal') {
          if (m.kind === 'click' && m.nodeId !== null) this.deps.set({ revealTarget: { tabId: m.tabId, scope: 'field', nodeId: m.nodeId }, armed: 'off' });
          return;
        }
        if (!forwardsInput(s.inputMode, s.level)) return;
        this.handleResult(this.control.pointer(pointerArgs(m.tabId, m)));
        return;
      case 'rp.wheel':
        if (forwardsInput(s.inputMode, s.level)) this.handleResult(this.control.scroll(scrollArgs(m.tabId, m)));
        return;
      case 'rp.key': {
        if (!forwardsInput(s.inputMode, s.level)) return;
        const a = keyArgs(m.tabId, m);
        if (a) this.handleResult(this.control.key(a));
        return;
      }
      case 'rp.error':
        console.warn('[replayer]', m.message);
        return;
    }
  }

  private handleResult(p: Promise<ControlResult> | null): void {
    void p?.then((r) => {
      if (r.ok) return;
      if (r.code === 'not_supported' && r.message === 'cross-origin frame') {
        this.deps.set({ frameHint: true });
        if (this.hintTimer) clearTimeout(this.hintTimer);
        this.hintTimer = setTimeout(() => this.deps.set({ frameHint: false }), 4000);
      } else if (r.code !== 'timeout') this.deps.set({ lastOp: { text: describeError(r), ok: false, at: Date.now() } });
    });
  }

  // ---------- control events ----------

  private onControlEvent(e: ControlEvent): void {
    const s = this.snap;
    if (e.kind === 'debugger') {
      const set = new Set(s.debuggerTabs);
      if (e.attached) set.add(e.tabId);
      else set.delete(e.tabId);
      const patch: Partial<PlaneSnap> = { debuggerTabs: [...set] };
      if (!e.attached && s.inputMode === 'deep') {
        patch.inputMode = 'in_page';
        if (e.cause === 'user') patch.lastOp = { text: 'The user stopped deep control.', ok: false, at: Date.now() };
      }
      this.deps.set(patch);
    } else if (e.kind === 'prompt') {
      this.deps.set({ promptOpen: e.state === 'shown' ? e.promptKind : null });
    }
  }

  // ---------- ops ----------

  /** Sends one op and records the outcome as the console notice. */
  async op(op: ControlOp, args: Record<string, unknown>, opts: { quiet?: boolean; okText?: string } = {}): Promise<ControlResult> {
    const r = await this.control.request(op, args);
    if (!opts.quiet) this.deps.set({ lastOp: r.ok ? { text: opts.okText ?? 'Done.', ok: true, at: Date.now() } : { text: describeError(r), ok: false, at: Date.now() } });
    return r;
  }

  allowed(op: ControlOp, args?: unknown): boolean {
    const level = this.snap.level;
    return level !== null && levelAtLeast(level, minLevelFor(op, args));
  }

  focus(tabId: number): void {
    this.deps.set({ tabs: setFocus(this.snap.tabs, tabId) });
    this.bridge.focus(tabId);
    void this.op('mirror.focus', { tabId }, { quiet: true });
  }

  setInputMode(mode: InputMode): void {
    const s = this.snap;
    const prev = s.inputMode;
    this.deps.set({ inputMode: mode, armed: s.armed === 'reveal' ? 'reveal' : 'off' });
    if (s.armed !== 'reveal') this.bridge.arm(forwardsInput(mode, s.level) ? 'input' : 'off');
    const tabId = s.tabs.focusedTabId;
    if (tabId === null) return;
    if (mode === 'deep' && prev !== 'deep') void this.op('input.mode', { tabId, mode: 'debugger' }, { okText: 'Deep control is on for this tab.' });
    else if (prev === 'deep' && mode !== 'deep') void this.op('input.mode', { tabId, mode: 'dom' }, { quiet: true });
  }

  armReveal(on: boolean): void {
    const s = this.snap;
    this.deps.set({ armed: on ? 'reveal' : 'off' });
    this.bridge.arm(on ? 'reveal' : forwardsInput(s.inputMode, s.level) ? 'input' : 'off');
  }

  setRevealTarget(t: RevealTarget | null): void {
    this.deps.set({ revealTarget: t });
  }

  async requestReveal(t: RevealTarget, reason: string): Promise<ControlResult> {
    this.deps.set({ revealTarget: null });
    const args: Record<string, unknown> = { tabId: t.tabId, scope: t.scope, reason };
    if (t.nodeId !== undefined) args.nodeId = t.nodeId;
    this.revealAsks.add(t.tabId);
    this.deps.recorder()?.ask(t.tabId);
    const r = await this.op('mask.request', args, { quiet: true });
    this.revealAsks.delete(t.tabId);
    this.deps.recorder()?.answered(t.tabId, r.ok && r.result.granted === true, t.scope);
    if (r.ok && r.result.granted === true) {
      const ttl = typeof r.result.ttlMs === 'number' ? r.result.ttlMs : LIMITS.revealTtlMs;
      this.deps.set({ revealUntil: { ...this.snap.revealUntil, [t.tabId]: Date.now() + ttl }, lastOp: { text: 'The user revealed it for up to a minute.', ok: true, at: Date.now() } });
    } else {
      this.deps.set({ lastOp: { text: r.ok ? 'The user did not reveal it.' : describeError(r), ok: false, at: Date.now() } });
    }
    return r;
  }

  dispose(): void {
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.offBridge();
    this.control.dispose();
    this.bridge.dispose();
  }
}
