/**
 * Parent side of the replayer frame protocol (Phase B 10.2). Every rrweb event is passed through the shared
 * `sanitiseRrwebEvent` before it is posted (the frame runs it again, section 12.3); messages from the frame are
 * accepted only when `event.source` is the frame's own window, `event.origin` is the frame's origin, and they
 * validate against `replayerMessageSchema`.
 *
 * Frame origin: the contract's opaque-origin frame cannot host rrweb (sandbox flags are inherited, so rrweb's own
 * inner iframe gets another opaque origin and its document is unreachable; checked in Chromium 156), so the frame
 * is same-origin (`REPLAYER_SANDBOX`) and posts are targeted at that origin. With an opaque frame (`'null'`) the
 * target would have to be `'*'`.
 */
import { sanitiseRrwebEvent } from '@indiansassist/shared';
import { replayerMessageSchema, type ArmMode, type ParentMessage, type ReplayerMessage } from './replayerProtocol';

type Listener = (msg: ReplayerMessage) => void;

/** Sanitises a list of rrweb events; events the sanitiser rejects (custom, plugin, adopted sheets, junk) are dropped. */
export function sanitiseEvents(events: readonly unknown[], sanitise: (e: unknown) => unknown = sanitiseRrwebEvent): unknown[] {
  const out: unknown[] = [];
  for (const e of events) {
    let clean: unknown;
    try {
      clean = sanitise(e);
    } catch {
      clean = null;
    }
    if (clean !== null && clean !== undefined) out.push(clean);
  }
  return out;
}

export type BridgeOptions = {
  /** The window that receives the frame's messages (the console's own window). */
  host?: Window;
  sanitise?: (e: unknown) => unknown;
  /** The frame document's origin: the console's own origin (default), or `'null'` for an opaque frame. */
  frameOrigin?: string;
};

export class ReplayerBridge {
  private frame: HTMLIFrameElement | null = null;
  private ready = false;
  private queue: ParentMessage[] = [];
  private listeners = new Set<Listener>();
  private readonly host: Window;
  private readonly sanitise: (e: unknown) => unknown;
  private readonly frameOrigin: string;
  /** Messages from other sources, or failing validation (diagnostics and tests). */
  rejected = 0;

  constructor(opts: BridgeOptions = {}) {
    this.host = opts.host ?? window;
    this.sanitise = opts.sanitise ?? sanitiseRrwebEvent;
    this.frameOrigin = opts.frameOrigin ?? this.host.location.origin;
    this.host.addEventListener('message', this.onMessage);
  }

  /** Binds the frame; a new frame starts unready (its replayers are gone) until it posts `rp.ready`. */
  attach(frame: HTMLIFrameElement | null): void {
    if (frame === this.frame) return;
    this.frame = frame;
    this.ready = false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  private onMessage = (ev: MessageEvent): void => {
    const win = this.frame?.contentWindow ?? null;
    if (!win || ev.source !== win || ev.origin !== this.frameOrigin) {
      if (ev.data && typeof ev.data === 'object' && String((ev.data as { t?: unknown }).t ?? '').startsWith('rp.')) this.rejected += 1;
      return;
    }
    const parsed = replayerMessageSchema.safeParse(ev.data);
    if (!parsed.success) {
      this.rejected += 1;
      return;
    }
    if (parsed.data.t === 'rp.ready') {
      this.ready = true;
      const q = this.queue;
      this.queue = [];
      for (const m of q) this.post(m);
    }
    for (const l of [...this.listeners]) l(parsed.data);
  };

  private post(msg: ParentMessage): void {
    const win = this.frame?.contentWindow;
    if (!win || !this.ready) {
      // Before the frame is ready only the newest state matters: a snapshot replaces everything queued for its tab.
      if (msg.t === 'rp.snapshot') this.queue = this.queue.filter((m) => !('tabId' in m) || m.tabId !== msg.tabId || m.t === 'rp.focus');
      this.queue.push(msg);
      return;
    }
    win.postMessage(msg, this.frameOrigin === 'null' ? '*' : this.frameOrigin);
  }

  /** Replaces the tab's replayer with one built from `events` (Meta + FullSnapshot, Phase B 4.4 replace rule). */
  snapshot(tabId: number, events: readonly unknown[]): number {
    const clean = sanitiseEvents(events, this.sanitise);
    this.post({ t: 'rp.snapshot', tabId, events: clean });
    return clean.length;
  }

  /** Incremental events for a live tab. Returns how many survived sanitation. */
  events(tabId: number, events: readonly unknown[]): number {
    const clean = sanitiseEvents(events, this.sanitise);
    if (clean.length > 0) this.post({ t: 'rp.events', tabId, events: clean });
    return clean.length;
  }

  focus(tabId: number | null): void {
    this.post({ t: 'rp.focus', tabId });
  }

  reset(tabId?: number): void {
    this.post(tabId === undefined ? { t: 'rp.reset' } : { t: 'rp.reset', tabId });
  }

  setSize(width: number, height: number): void {
    this.post({ t: 'rp.setSize', width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) });
  }

  arm(mode: ArmMode): void {
    this.post({ t: 'rp.arm', mode });
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  dispose(): void {
    this.host.removeEventListener('message', this.onMessage);
    this.listeners.clear();
    this.queue = [];
    this.frame = null;
    this.ready = false;
  }
}
