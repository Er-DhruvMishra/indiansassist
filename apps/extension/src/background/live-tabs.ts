/**
 * Tabs during an active session (sections 4.3-4.5, 9.2): registry entries, capture injection per scope, tab
 * events (navigation re-classification incl. redirects into denied hosts, close, activate), focus ownership,
 * pause / resume, attach, and the debounced `mirror.tabs` feed to the Assist.
 */
import {
  dcMirrorTabSchema,
  dcMirrorTabsSchema,
  levelAtLeast,
  type ConsentLevel,
  type MirrorTransport,
  type TabInfo,
} from '@indiansassist/shared';
import { ext } from '../shared/api';
import { sendToTab } from '../shared/bus';
import type { BarState } from '../shared/bus-schemas';
import type { TabState } from '../shared/storage';
import { LiveExtras } from './live-extras';
import type { LiveSession } from './live-session';
import { afterNavigation, initialTabState, listForAssist, queryTabs, toTabInfo } from './tab-registry';

type MirrorTabState = 'attached' | 'detached' | 'paused' | 'resumed' | 'denied' | 'too_large' | 'navigated' | 'revealed' | 'restored';

export class LiveTabs extends LiveExtras {
  lastInfos: TabInfo[] = [];
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(live: LiveSession) {
    super(live);
  }

  mirroredIds(): number[] {
    return Object.entries(this.s.tabs)
      .filter(([, st]) => st.mirrored === 'yes' && !st.paused)
      .map(([id]) => Number(id));
  }

  info(tab: chrome.tabs.Tab): TabInfo | null {
    const st = tab.id !== undefined ? this.state(tab.id) : undefined;
    const fav = this.live.favicons.peek(tab.favIconUrl);
    if (fav === undefined && tab.favIconUrl) void this.live.favicons.load(tab.favIconUrl).then(() => this.scheduleTabsPush());
    return toTabInfo(tab, st, fav ?? null);
  }

  /** consent.ok: every open tab classified, the consented / all tabs injected, default focus set. */
  async initialise(): Promise<void> {
    const consent = this.s.consent!;
    const tabs = await ext().tabs.query({});
    for (const tab of tabs) {
      if (tab.id === undefined || tab.incognito) continue;
      const st = initialTabState(tab.url ?? tab.pendingUrl, this.deny(), consent.scope, { inScope: tab.id === this.s.consentTabId });
      this.s.tabs[String(tab.id)] = st;
      if (st.mirrored === 'yes') this.logShared(st);
    }
    if (consent.scope === 'all_tabs') await this.live.registry.registerAllTabs(this.deny()).catch(() => undefined);
    for (const id of this.mirroredIds()) await this.live.registry.inject(id);
    const active = tabs.find((t) => t.active && t.id !== undefined && this.state(t.id)?.mirrored === 'yes');
    const focus = consent.scope === 'current_tab' ? this.s.consentTabId : (active?.id ?? this.mirroredIds()[0] ?? null);
    if (focus !== null && focus !== undefined) await this.focus(focus);
    this.scheduleTabsPush();
  }

  injectFailed(tabId: number): void {
    const st = this.state(tabId);
    if (!st) return;
    st.mirrored = 'unsupported';
    st.error = 'inject_failed';
    st.injected = false;
    this.changed(tabId, 'detached');
  }

  /** `cs.ready` from a capture script: start it (it stays inert until then). */
  async onReady(tabId: number, skipped: string[] | undefined): Promise<void> {
    const st = this.state(tabId);
    if (!st || st.mirrored !== 'yes') {
      await sendToTab(tabId, { t: 'cs.stop' });
      return;
    }
    this.live.registry.ready(tabId);
    st.injected = true;
    await sendToTab(tabId, { t: 'cs.start', policy: this.live.capturePolicy(), bar: this.live.barFor(tabId), level: this.live.level() });
    if (st.paused) await sendToTab(tabId, { t: 'cs.pause' });
    if (skipped && skipped.length > 0) this.live.m.ui.set({ status: `Skipped ${skipped.length} invalid organisation selector(s).` });
    this.m.persist();
  }

  async focus(tabId: number): Promise<void> {
    this.s.focusedTabId = tabId;
    await this.live.m.offscreen.send({ t: 'mirror.focus', tabId });
    this.scheduleTabsPush();
  }

  /** The Desk (side panel) or an approved `mirror.attach` adds a tab under `current_tab`. */
  async attach(tabId: number): Promise<void> {
    const tab = await ext().tabs.get(tabId);
    const st = initialTabState(tab.url ?? tab.pendingUrl, this.deny(), this.live.scope(), { inScope: true });
    const prev = this.state(tabId);
    if (prev) Object.assign(st, { backstage: prev.backstage, createdByAssist: prev.createdByAssist });
    this.s.tabs[String(tabId)] = st;
    if (st.mirrored !== 'yes') return this.changed(tabId, st.mirrored === 'denied' ? 'denied' : 'detached');
    this.logShared(st);
    await this.live.registry.inject(tabId);
    this.live.attest('mirror.started', { reason: 'attach', scope: this.live.scope(), level: this.live.level(), tabCount: this.mirroredIds().length, tabId });
    this.changed(tabId, 'attached');
  }

  /** A tab the Assist created (`tabs.create`, `backstage.enter`): mirrored under either scope. */
  async assistCreated(tab: chrome.tabs.Tab, backstage: boolean): Promise<void> {
    if (tab.id === undefined) return;
    const st = initialTabState(tab.pendingUrl ?? tab.url, this.deny(), this.live.scope(), { inScope: true, createdByAssist: true, backstage });
    this.s.tabs[String(tab.id)] = st;
    if (st.mirrored === 'yes') this.logShared(st);
    this.changed(tab.id, 'attached');
  }

  // ---------- chrome.tabs events ----------

  onCreated(tab: chrome.tabs.Tab): void {
    if (tab.id === undefined || tab.incognito || this.state(tab.id)) return;
    this.s.tabs[String(tab.id)] = initialTabState(tab.pendingUrl ?? tab.url, this.deny(), this.live.scope(), { inScope: false });
    this.scheduleTabsPush();
  }

  async onUpdated(tabId: number, change: { status?: string; url?: string; title?: string; audible?: boolean; mutedInfo?: unknown; pinned?: boolean; favIconUrl?: string; groupId?: number }, tab: chrome.tabs.Tab): Promise<void> {
    const st = this.state(tabId);
    if (!st) return this.onCreated(tab);
    if (change.status === 'loading' && (change.url !== undefined || st.injected)) await this.navigated(tabId, st, tab.pendingUrl ?? tab.url);
    else if (change.status === 'complete' && st.mirrored === 'yes' && !st.injected && !st.paused) await this.live.registry.inject(tabId);
    this.scheduleTabsPush();
  }

  private async navigated(tabId: number, st: TabState, url: string | undefined): Promise<void> {
    if (st.reveal) this.endRevealLocally(tabId, 'navigation');
    const wasYes = st.mirrored === 'yes' && !st.paused;
    const next = afterNavigation(st, url, this.deny(), this.live.scope());
    this.s.tabs[String(tabId)] = next;
    this.live.registry.forget(tabId);
    if (next.mirrored !== 'yes' || next.paused) {
      if (next.mirrored === 'denied') {
        await this.live.debuggerControl.detach(tabId, 'navigation');
        if (wasYes) this.live.attest('mirror.stopped', { reason: 'policy', tabId, ...this.counters(tabId) });
      }
      if (next.mirrored !== 'yes') await sendToTab(tabId, { t: 'cs.stop' });
      return this.changed(tabId, next.mirrored === 'denied' ? 'denied' : 'navigated');
    }
    if (this.live.scope() === 'all_tabs' && this.live.registry.isRegistered) this.live.registry.expectReady(tabId);
    else await this.live.registry.inject(tabId);
    this.changed(tabId, 'navigated');
  }

  onRemoved(tabId: number): void {
    const st = this.state(tabId);
    if (!st) return;
    const wasMirrored = st.mirrored === 'yes';
    if (st.backstage) this.backstageClosed(tabId, st);
    this.closeShared(st);
    delete this.s.tabs[String(tabId)];
    this.live.registry.forget(tabId);
    if (this.s.focusedTabId === tabId) this.s.focusedTabId = null;
    if (wasMirrored && this.mirroredIds().length === 0)
      this.live.attest('mirror.stopped', { reason: 'all_tabs_closed', batches: this.s.counters.batches, bytes: this.s.counters.bytes });
    this.m.persist();
    this.scheduleTabsPush();
  }

  // ---------- pause / resume ----------

  async pause(tabId: number, paused: boolean, cause: 'desk' | 'bar_hidden' = 'desk'): Promise<void> {
    const st = this.state(tabId);
    if (!st || st.mirrored !== 'yes' || st.paused === paused) return;
    st.paused = paused;
    if (paused) {
      if (st.reveal) this.endRevealLocally(tabId, 'pause');
      await this.live.debuggerControl.detach(tabId, 'pause');
      await sendToTab(tabId, { t: 'cs.pause' });
      this.live.attest('mirror.stopped', { reason: cause === 'bar_hidden' ? 'error' : 'paused', tabId, ...this.counters(tabId) });
    } else {
      await sendToTab(tabId, { t: 'cs.resume' });
      this.live.attest('mirror.started', { reason: 'resumed', scope: this.live.scope(), level: this.live.level(), tabCount: this.mirroredIds().length, tabId });
    }
    this.live.send({ t: 'ctl.event', kind: 'paused', tabId, paused, ts: Date.now() });
    await this.updateBar(tabId, { paused });
    if (cause === 'bar_hidden') this.live.m.ui.set({ status: 'Paused: the page hides the sharing bar' });
    this.changed(tabId, paused ? 'paused' : 'resumed');
  }

  async tooLarge(tabId: number, transport: MirrorTransport): Promise<void> {
    const st = this.state(tabId);
    if (!st || st.mirrored !== 'yes') return;
    st.mirrored = 'too_large';
    this.live.attest('mirror.stopped', { reason: 'too_large', tabId, ...this.counters(tabId) });
    this.changed(tabId, 'too_large', transport);
  }

  async levelChanged(level: ConsentLevel): Promise<void> {
    for (const [id, st] of Object.entries(this.s.tabs)) {
      if (st.reveal && !levelAtLeast(level, st.reveal.level)) this.endRevealLocally(Number(id), 'level');
      if (st.injected) await sendToTab(Number(id), { t: 'cs.level', level });
    }
  }

  // ---------- bars ----------

  async updateBar(tabId: number, patch: Partial<BarState>): Promise<void> {
    if (this.state(tabId)?.injected) await sendToTab(tabId, { t: 'cs.bar', bar: patch });
  }

  async updateAllBars(patch: Partial<BarState>): Promise<void> {
    for (const [id, st] of Object.entries(this.s.tabs)) if (st.injected) await sendToTab(Number(id), { t: 'cs.bar', bar: patch });
  }

  async reapplyBars(): Promise<void> {
    for (const [id, st] of Object.entries(this.s.tabs)) if (st.injected) await sendToTab(Number(id), { t: 'cs.bar', bar: this.live.barFor(Number(id)) });
  }

  // ---------- feed to the Assist ----------

  changed(tabId: number, state: MirrorTabState, transport?: MirrorTransport): void {
    this.m.persist();
    void this.sendTab(tabId, state, transport);
    this.scheduleTabsPush();
  }

  private async sendTab(tabId: number, state: MirrorTabState, transport?: MirrorTransport): Promise<void> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await ext().tabs.get(tabId);
    } catch {
      return;
    }
    const info = this.info(tab);
    if (!info || (this.live.scope() === 'current_tab' && info.mirrored === 'not_in_scope')) return;
    const msg = { t: 'mirror.tab', tab: info, state, ...(transport ? { transport } : {}), ts: Date.now() };
    if (dcMirrorTabSchema.safeParse(msg).success) await this.live.m.offscreen.send({ t: 'dc.send', label: 'ia.mirror', msg });
  }

  scheduleTabsPush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushTabs();
    }, 250);
  }

  async collect(): Promise<{ infos: TabInfo[]; activeTabId: number | null }> {
    const tabs = await ext().tabs.query({});
    const infos = tabs.map((t) => this.info(t)).filter((x): x is TabInfo => x !== null);
    const lastFocused = await ext().windows.getLastFocused().catch(() => null);
    const active = tabs.find((t) => t.active && (lastFocused ? t.windowId === lastFocused.id : true));
    return { infos, activeTabId: active?.id ?? null };
  }

  async pushTabs(): Promise<void> {
    if (!this.m.s?.consent) return;
    const { infos, activeTabId } = await this.collect();
    const { tabs, hiddenCount } = listForAssist(infos, this.live.scope());
    this.lastInfos = tabs;
    const visibleActive = tabs.some((t) => t.tabId === activeTabId) ? activeTabId : null;
    const msg = { t: 'mirror.tabs', tabs, hiddenCount, activeTabId: visibleActive, focusedTabId: this.s.focusedTabId ?? null, ts: Date.now() };
    if (dcMirrorTabsSchema.safeParse(msg).success) await this.live.m.offscreen.send({ t: 'dc.send', label: 'ia.mirror', msg });
    this.m.refreshUi();
  }

  async list(): Promise<Record<string, unknown>> {
    const { infos, activeTabId } = await this.collect();
    const { tabs, hiddenCount } = listForAssist(infos, this.live.scope());
    return { tabs, hiddenCount, activeTabId: tabs.some((t) => t.tabId === activeTabId) ? activeTabId : null, focusedTabId: this.s.focusedTabId ?? null };
  }

  async query(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { infos } = await this.collect();
    const hosts = new Map<number, string | null>();
    for (const [id, st] of Object.entries(this.s.tabs)) hosts.set(Number(id), st.host);
    return queryTabs(infos, hosts, args);
  }
}
