/**
 * The capture script's controller (section 9.2): inert until `cs.start` (no DOM touch, no Port), then rrweb
 * recording into the batcher and the `ia.mirror` Port, the bar, the title prefix, input replay and reveals.
 * When its Port is lost and cannot be re-opened within 5 s it stops and cleans up on its own.
 */
import type { ConsentLevel } from '@indiansassist/shared';
import { offscreenToContentSchema, workerToContentSchema, type BarState, type CapturePolicy, type WorkerToContent } from '../shared/bus-schemas';
import { MIRROR_PORT, PORT_LOSS_STOP_MS } from '../shared/constants';
import { AnnotOverlay } from './annot-overlay';
import { Batcher } from './batcher';
import { IndicatorBar, TitleGuard } from './indicator';
import { replayInput } from './input-replay';
import { Recorder, crossOriginSheets } from './recorder';
import { RevealController } from './reveal';
import { buildSelectors, type CaptureSelectors } from './selectors';
import { EverPassword, UnmaskStore, checkFieldTarget, fieldLabel } from './unmask';

export type RuntimeLike = {
  connect: (info: { name: string }) => chrome.runtime.Port;
  sendMessage: (msg: unknown) => Promise<unknown> | void;
};

export type CaptureState = 'inert' | 'running' | 'paused' | 'too_large' | 'stopped';

export class Capture {
  state: CaptureState = 'inert';
  private port: chrome.runtime.Port | null = null;
  private portLostAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  readonly recorder = new Recorder();
  readonly ever = new EverPassword();
  readonly unmask = new UnmaskStore();
  readonly batcher: Batcher;
  readonly reveal: RevealController;
  bar: IndicatorBar | null = null;
  private title: TitleGuard | null = null;
  private annot: AnnotOverlay | null = null;
  private selectors: CaptureSelectors | null = null;
  private policy: CapturePolicy | null = null;
  private css = new Map<string, string>();
  private cssWaiters = new Map<string, () => void>();
  level: ConsentLevel = 'view';

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly rt: RuntimeLike,
    private readonly onStopped: () => void = () => undefined,
  ) {
    this.batcher = new Batcher(
      (b) => this.post({ t: 'cs.events', events: b.events, snapshot: b.snapshot }),
      () => this.recorder.takeFullSnapshot(),
    );
    this.reveal = new RevealController(doc, this.unmask, () => this.recorder.takeFullSnapshot(), (scope, by, durationMs) =>
      this.toWorker({ t: 'cs.revealEnded', scope, by, durationMs }),
    );
  }

  private toWorker(msg: { t: string } & Record<string, unknown>): void {
    void Promise.resolve(this.rt.sendMessage({ ...msg, to: 'worker' })).catch(() => undefined);
  }

  private post(msg: Record<string, unknown>): void {
    try {
      this.port?.postMessage(msg);
    } catch {
      /* port gone; the loss handler stops us */
    }
  }

  /** Announces the script; carries no URL (the worker already has it). */
  announce(skipped?: string[]): void {
    this.toWorker({ t: 'cs.ready', ...(skipped && skipped.length > 0 ? { skippedSelectors: skipped } : {}) });
  }

  // ---------- worker messages ----------

  handleWorker(raw: unknown): unknown {
    const parsed = workerToContentSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const m = parsed.data;
    if (m.t === 'cs.ping') return { ok: true };
    if (m.t === 'cs.start') return void this.start(m.policy, m.bar, m.level);
    if (this.state === 'inert' || this.state === 'stopped') return m.t === 'cs.input' || m.t === 'cs.unmask' ? { ok: false, error: 'not_supported', cause: 'bad_target' } : undefined;
    return this.handleLive(m);
  }

  private handleLive(m: WorkerToContent): unknown {
    switch (m.t) {
      case 'cs.stop':
        return void this.stop();
      case 'cs.pause':
        return void this.pause();
      case 'cs.resume':
        return void this.resume();
      case 'cs.level':
        this.level = m.level;
        return undefined;
      case 'cs.bar':
        return void this.bar?.update(m.bar);
      case 'cs.toast':
        return void this.bar?.toast(m.text);
      case 'cs.prompt':
        return void this.bar?.showPrompt(m.id, m.text, m.panelOnly === true);
      case 'cs.promptClear':
        return void this.bar?.clearPrompt(m.id);
      case 'cs.input':
        if (this.state !== 'running') return { ok: false, error: 'not_supported', message: 'this tab is not shared now' };
        return replayInput(m.op, m.args, (id) => this.recorder.getNode(id), this.doc, this.win);
      case 'cs.unmask':
        return this.proposeUnmask(m.scope, m.nodeId);
      case 'cs.unmaskDecision':
        this.reveal.decide(m.granted, m.ttlMs);
        return { ok: true };
      case 'cs.hide':
        this.reveal.end(m.by);
        return { ok: true };
      case 'cs.annot':
        (this.annot ??= new AnnotOverlay(this.doc)).apply(m.msg as never);
        return undefined;
      default:
        return undefined;
    }
  }

  private proposeUnmask(scope: 'field' | 'tab', nodeId: number | null): unknown {
    if (this.state !== 'running') return { ok: false, cause: 'bad_target' };
    if (scope === 'tab') {
      const outline = this.reveal.propose('tab', null);
      return { ok: true, fieldKind: 'text', label: 'all hidden fields on this tab', outline };
    }
    const target = checkFieldTarget(nodeId !== null ? this.recorder.getNode(nodeId) : null, this.ever);
    if (!target.ok) return { ok: false, cause: target.cause };
    const outline = this.reveal.propose('field', target.el);
    return { ok: true, fieldKind: target.fieldKind, label: fieldLabel(target.el, this.doc), outline };
  }

  // ---------- lifecycle ----------

  async start(policy: CapturePolicy, bar: BarState, level: ConsentLevel): Promise<void> {
    if (this.state === 'running' || this.state === 'paused') {
      this.bar?.update(bar);
      return;
    }
    this.policy = policy;
    this.level = level;
    this.selectors = buildSelectors(policy, this.doc);
    if (this.selectors.dropped) this.toWorker({ t: 'cs.error', message: 'selectors_dropped' });
    this.ever.observe(this.doc);
    this.openPort();
    this.bar = new IndicatorBar(this.doc, {
      onPause: () => this.toWorker({ t: 'cs.pauseClicked' }),
      onResume: () => this.toWorker({ t: 'cs.resumeClicked' }),
      onStop: () => this.toWorker({ t: 'cs.stopClicked' }),
      onHide: () => this.toWorker({ t: 'cs.hideClicked' }),
      onPromptAnswer: (id, decision) => this.toWorker({ t: 'cs.promptAnswer', id, decision }),
      onCloseBackstage: () => this.toWorker({ t: 'cs.closeBackstageClicked' }),
      onHiddenTooLong: () => this.toWorker({ t: 'cs.barHidden' }),
    });
    this.bar.mount(bar);
    if (policy.titlePrefix) (this.title = new TitleGuard(this.doc)).start();
    this.state = bar.paused ? 'paused' : 'running';
    await this.prefetchCss();
    if (this.state === 'running') this.startRecorder();
  }

  /** Cross-origin stylesheets are fetched by the offscreen document before the first snapshot (5 s max). */
  private async prefetchCss(): Promise<void> {
    const urls = crossOriginSheets(this.doc).filter((u) => !this.css.has(u));
    if (urls.length === 0) return;
    await Promise.race([
      Promise.all(urls.map((url) => new Promise<void>((resolve) => {
        this.cssWaiters.set(url, resolve);
        this.post({ t: 'cs.fetchCss', url });
      }))),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ]);
  }

  private startRecorder(): void {
    if (!this.selectors) return;
    this.batcher.reset();
    this.recorder.start({
      selectors: this.selectors,
      ever: this.ever,
      unmask: this.unmask,
      css: this.css,
      emit: (e) => this.batcher.push(e),
      onError: (message) => this.toWorker({ t: 'cs.error', message }),
    });
  }

  private pause(): void {
    if (this.state !== 'running') return;
    this.reveal.end('pause');
    this.recorder.stop();
    this.batcher.reset();
    this.state = 'paused';
    this.bar?.update({ paused: true });
  }

  private resume(): void {
    if (this.state !== 'paused' && this.state !== 'too_large') return;
    this.state = 'running';
    this.bar?.update({ paused: false });
    this.bar?.resetHidden();
    this.startRecorder();
  }

  // ---------- the ia.mirror Port ----------

  private openPort(): boolean {
    try {
      const port = this.rt.connect({ name: MIRROR_PORT });
      this.port = port;
      port.onMessage.addListener((msg: unknown) => this.onPortMessage(msg));
      port.onDisconnect.addListener(() => this.onPortLost(port));
      return true;
    } catch {
      return false;
    }
  }

  private onPortMessage(raw: unknown): void {
    this.portLostAt = null;
    const parsed = offscreenToContentSchema.safeParse(raw);
    if (!parsed.success) return;
    const m = parsed.data;
    if (m.t === 'oc.focus') this.batcher.setFocused(m.focused);
    else if (m.t === 'oc.snapshot') {
      if (this.state === 'too_large') this.resume();
      else if (this.state === 'running') this.recorder.takeFullSnapshot();
    } else if (m.t === 'oc.css') {
      if (m.text !== null) this.css.set(m.url, m.text);
      this.cssWaiters.get(m.url)?.();
      this.cssWaiters.delete(m.url);
    } else if (m.t === 'oc.stop' && this.state === 'running') {
      this.recorder.stop();
      this.batcher.reset();
      this.state = 'too_large';
    }
  }

  /** Port lost: retry every second; after 5 s without an owner the script stops itself. */
  private onPortLost(port: chrome.runtime.Port): void {
    if (this.port !== port || this.state === 'stopped') return;
    this.port = null;
    this.portLostAt ??= Date.now();
    if (this.reconnectTimer) return;
    this.reconnectTimer = setInterval(() => {
      if (this.state === 'stopped') return this.clearReconnect();
      if (this.portLostAt !== null && Date.now() - this.portLostAt >= PORT_LOSS_STOP_MS) {
        this.clearReconnect();
        return this.stop();
      }
      if (!this.port) this.openPort();
    }, 1000);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.reveal.end('end', false);
    this.reveal.cancelProposal();
    this.recorder.stop();
    this.batcher.reset();
    this.bar?.destroy();
    this.bar = null;
    this.title?.stop();
    this.title = null;
    this.annot?.destroy();
    this.annot = null;
    this.ever.disconnect();
    this.unmask.clear();
    this.clearReconnect();
    const p = this.port;
    this.port = null;
    try {
      p?.disconnect();
    } catch {
      /* gone */
    }
    this.state = 'stopped';
    this.policy = null;
    this.onStopped();
  }

  get capturePolicy(): CapturePolicy | null {
    return this.policy;
  }
}
