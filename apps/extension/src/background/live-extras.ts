/**
 * Reveals (section 8.4), backstage tabs (section 6), tab-bar prompts and toasts (section 3.3) and annotation
 * routing (Y8) of an active session. Base class of `LiveTabs`.
 */
import { dcAnnotSchema, hostOf, type MaskRestoreCause, type MirrorTransport } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { sendToTab } from '../shared/bus';
import type { BarState } from '../shared/bus-schemas';
import type { TabState } from '../shared/storage';
import { wireHost } from './control-handler';
import type { LiveSession } from './live-session';

type TabStateName = 'attached' | 'detached' | 'paused' | 'resumed' | 'denied' | 'too_large' | 'navigated' | 'revealed' | 'restored';

export abstract class LiveExtras {
  private barPrompts = new Map<string, number[]>();
  private revealMeta = new Map<number, { reason: string; fieldKind?: string; startedAt: number }>();

  constructor(protected readonly live: LiveSession) {}

  abstract changed(tabId: number, state: TabStateName, transport?: MirrorTransport): void;
  abstract updateBar(tabId: number, patch: Partial<BarState>): Promise<void>;
  abstract updateAllBars(patch: Partial<BarState>): Promise<void>;
  abstract mirroredIds(): number[];

  protected get s() {
    return this.live.s;
  }
  protected get m() {
    return this.live.m;
  }
  protected state(tabId: number): TabState | undefined {
    return this.s.tabs[String(tabId)];
  }
  protected deny(): string[] {
    return this.live.eff().denyList;
  }

  /** Per-tab `batches` / `bytes` (wire bytes on `ia.mirror` or relay) for per-tab `mirror.stopped`. */
  protected counters(tabId: number): { batches: number; bytes: number } {
    const c = this.live.tabCounters.get(tabId);
    return { batches: c?.batches ?? 0, bytes: c?.bytes ?? 0 };
  }

  protected logShared(st: TabState): void {
    if (st.host) this.s.log.tabsShared.push({ host: st.host, from: new Date().toISOString(), to: null });
  }

  protected closeShared(st: TabState): void {
    const row = [...this.s.log.tabsShared].reverse().find((r) => r.host === st.host && r.to === null);
    if (row) row.to = new Date().toISOString();
  }

  // ---------- reveals ----------

  revealGranted(tabId: number, scope: 'field' | 'tab', reason: string, fieldKind?: string): void {
    const st = this.state(tabId);
    if (!st) return;
    st.reveal = { scope, until: Date.now() + 60000, level: this.live.level() };
    this.revealMeta.set(tabId, { reason, fieldKind, startedAt: Date.now() });
    void this.updateBar(tabId, { revealed: true });
    this.changed(tabId, 'revealed');
  }

  /** `cs.revealEnded` from the content script (TTL, blur, Hide again, navigation inside the document). */
  revealEnded(tabId: number, scope: 'field' | 'tab', by: MaskRestoreCause, durationMs: number): void {
    const st = this.state(tabId);
    if (!st?.reveal) return;
    delete st.reveal;
    const meta = this.revealMeta.get(tabId);
    this.revealMeta.delete(tabId);
    this.live.attest('mask.restored', { tabId, scope, durationMs, by });
    this.s.log.unmasks.push({ host: st.host ?? '', scope, ...(meta?.fieldKind ? { fieldKind: meta.fieldKind } : {}), reason: meta?.reason ?? '', durationMs });
    void this.updateBar(tabId, { revealed: false });
    this.changed(tabId, 'restored');
  }

  /** Ends a reveal from the worker side (pause, navigation, level drop, end); the document may be gone. */
  endRevealLocally(tabId: number, by: MaskRestoreCause): void {
    const st = this.state(tabId);
    if (!st?.reveal) return;
    const meta = this.revealMeta.get(tabId);
    const durationMs = Math.max(0, Date.now() - (meta?.startedAt ?? Date.now()));
    void sendToTab(tabId, { t: 'cs.hide', by });
    this.revealEnded(tabId, st.reveal.scope, by, durationMs);
  }

  // ---------- backstage ----------

  backstageEntered(tabId: number, url: string, opId: string): void {
    const st = this.state(tabId);
    if (!st) return;
    st.backstage = true;
    st.backstageOpId = opId;
    const host = wireHost(url) ?? hostOf(url) ?? '';
    this.live.attest('backstage.enter', { tabId, host, opId, ok: true });
    this.live.send({ t: 'ctl.event', kind: 'backstage', tabId, state: 'opened', ts: Date.now() });
    void this.updateAllBars({ backstageCount: this.live.backstageCount() });
    this.m.persist();
  }

  async backstageExit(tabId: number, action: 'close' | 'keep' | 'bring_to_front', opId: string): Promise<void> {
    const st = this.state(tabId)!;
    if (action === 'close') {
      st.backstageOpId = `exit:${opId}`;
      await ext().tabs.remove(tabId);
      return;
    }
    if (action === 'bring_to_front') {
      const tab = await ext().tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await ext().windows.update(tab.windowId, { focused: true });
    }
    const outcome = action === 'keep' ? 'kept' : 'brought_to_front';
    this.finishBackstage(tabId, st, outcome, opId);
    if (action === 'bring_to_front') this.live.send({ t: 'ctl.event', kind: 'backstage', tabId, state: 'front', ts: Date.now() });
  }

  /** Session end with "Close technician's background tabs" unticked: the tab stays (`kept`, no opId). */
  async keepBackstage(tabId: number): Promise<void> {
    const st = this.state(tabId);
    if (st?.backstage) this.finishBackstage(tabId, st, 'kept', undefined);
  }

  /** The backstage tab was closed (Assist `close`, Desk Close / Close all / tab close button, session end). */
  protected backstageClosed(tabId: number, st: TabState): void {
    const opId = st.backstageOpId?.startsWith('exit:') ? st.backstageOpId.slice(5) : undefined;
    this.finishBackstage(tabId, st, 'closed', opId);
    this.live.send({ t: 'ctl.event', kind: 'backstage', tabId, state: 'closed', ts: Date.now() });
  }

  private finishBackstage(tabId: number, st: TabState, outcome: 'closed' | 'kept' | 'brought_to_front', opId: string | undefined): void {
    st.backstage = false;
    delete st.backstageOpId;
    this.live.attest('backstage.exit', { tabId, outcome, durationMs: Math.max(0, Date.now() - st.enteredAt), ...(opId ? { opId } : {}) });
    this.s.log.backstage.push({ host: st.host ?? '', outcome });
    void this.updateAllBars({ backstageCount: this.live.backstageCount() });
    this.m.persist();
  }

  /** Session end: attest the close first, then close (onRemoved finds no entry and writes nothing twice). */
  async closeBackstageNow(tabId: number): Promise<void> {
    const st = this.state(tabId);
    if (!st?.backstage) return;
    this.backstageClosed(tabId, st);
    delete this.s.tabs[String(tabId)];
    await ext().tabs.remove(tabId).catch(() => undefined);
  }

  async closeBackstage(which: number | 'all'): Promise<void> {
    const ids = Object.entries(this.s.tabs)
      .filter(([id, st]) => st.backstage && (which === 'all' || Number(id) === which))
      .map(([id]) => Number(id));
    for (const id of ids) await ext().tabs.remove(id).catch(() => undefined);
  }

  /** The first backstage tab of a session: a 10 s toast in the Desk's active mirrored tab (section 3.3). */
  async toast(tabId: number, url: string): Promise<void> {
    const host = hostOf(url) ?? 'a site';
    const [active] = await ext().tabs.query({ active: true, lastFocusedWindow: true });
    const target = active?.id !== undefined && this.state(active.id)?.injected ? active.id : null;
    const text = `Technician opened a background tab: ${host}`;
    if (target !== null) await sendToTab(target, { t: 'cs.toast', text, closeBackstageTabId: tabId });
    else this.m.ui.set({ status: text });
  }

  // ---------- bar prompts ----------

  async barPrompt(tabId: number | null, id: string, text: string): Promise<void> {
    let targets: number[] = [];
    if (tabId !== null) targets = [tabId];
    else {
      const [active] = await ext().tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id !== undefined && this.state(active.id)?.injected) targets = [active.id];
    }
    this.barPrompts.set(id, targets);
    for (const t of targets) await sendToTab(t, { t: 'cs.prompt', id, text: text.slice(0, 1200) });
  }

  async clearBarPrompt(id: string): Promise<void> {
    for (const t of this.barPrompts.get(id) ?? []) await sendToTab(t, { t: 'cs.promptClear', id });
    this.barPrompts.delete(id);
  }

  // ---------- annotations ----------

  /** P2 annotations carry a required `tabId` (Y8); drawn by that tab's content script. */
  async annotate(raw: Record<string, unknown>): Promise<void> {
    const parsed = dcAnnotSchema.safeParse(raw);
    if (!parsed.success || parsed.data.tabId === undefined) return;
    const st = this.state(parsed.data.tabId);
    if (!st?.injected || st.paused) return;
    await sendToTab(parsed.data.tabId, { t: 'cs.annot', msg: parsed.data as unknown as Record<string, unknown> });
  }
}
