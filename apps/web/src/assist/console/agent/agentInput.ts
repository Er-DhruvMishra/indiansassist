/**
 * Console side of P3 input (docs/specs/phase-c-contracts.md sections 3.8, 5.1, 5.2):
 * - `InputReporter`: the user twin of `control.input { mode: 'os' }`, aggregated per monitor over 10 s windows
 *   (`monitorId` per the shared `controlInputMonitorId` rule), plus `input.text_burst` above 200 characters / 10 s;
 * - `TextBuffer`: printable characters flushed as one `os.text` every 50 ms or 32 characters;
 * - key routing: named keys, modifier chords and numpad codes go through `os.key`, the rest is text.
 */
import { LIMITS, agentInputKind, controlInputMonitorId } from '@indiansassist/shared';

type Kind = 'pointer' | 'scroll' | 'key' | 'text';
type Window = { monitorId: number; count: number; kinds: Set<Kind>; textChars: number; startedAt: number };

export type InputReport = {
  action: 'control.input' | 'input.text_burst';
  data: Record<string, unknown>;
};

export class InputReporter {
  private windows = new Map<number, Window>();
  private lastPointerMonitor: number | null = null;
  private lastPointerAt = 0;
  private textWindow: { chars: number; startedAt: number; monitorId: number; reported: boolean } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly report: (r: InputReport) => void,
    private readonly viewed: () => number | null,
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = LIMITS.controlInputAggregateMs,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(false), 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Records one sent op (only `control.input` kinds count; `clipboard.set` is `clipboard.sync`). */
  record(op: string, args: Record<string, unknown>): void {
    const kind = agentInputKind(op);
    if (!kind) return;
    const now = this.now();
    if (now - this.lastPointerAt > this.windowMs) this.lastPointerMonitor = null;
    const monitorId = controlInputMonitorId({ op, args, lastPointerMonitorId: this.lastPointerMonitor, viewedMonitorId: this.viewed() });
    if (kind === 'pointer' || kind === 'scroll') {
      this.lastPointerMonitor = monitorId;
      this.lastPointerAt = now;
    }
    let w = this.windows.get(monitorId);
    if (!w) {
      w = { monitorId, count: 0, kinds: new Set(), textChars: 0, startedAt: now };
      this.windows.set(monitorId, w);
    }
    w.count += 1;
    w.kinds.add(kind);
    if (kind === 'text') {
      const chars = typeof args['text'] === 'string' ? (args['text'] as string).length : 0;
      w.textChars += chars;
      this.trackBurst(chars, monitorId, now);
    }
  }

  private trackBurst(chars: number, monitorId: number, now: number): void {
    if (!this.textWindow || now - this.textWindow.startedAt > this.windowMs)
      this.textWindow = { chars: 0, startedAt: now, monitorId, reported: false };
    const t = this.textWindow;
    t.chars += chars;
    if (!t.reported && t.chars > LIMITS.textBurstChars) {
      t.reported = true;
      this.report({ action: 'input.text_burst', data: { chars: t.chars, windowMs: Math.max(1, now - t.startedAt), monitorId } });
    }
  }

  /** Reports every window older than 10 s (or every window when `all`, before `session.end`). */
  flush(all: boolean): void {
    const now = this.now();
    for (const [id, w] of [...this.windows]) {
      if (!all && now - w.startedAt < this.windowMs) continue;
      this.windows.delete(id);
      this.report({
        action: 'control.input',
        data: {
          mode: 'os',
          monitorId: w.monitorId,
          count: w.count,
          kinds: [...w.kinds],
          windowMs: Math.max(1, Math.min(this.windowMs, now - w.startedAt)),
          textChars: w.textChars,
        },
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush(true);
  }
}

/** Printable characters buffered and flushed as one `os.text` every 50 ms or 32 characters (section 5.2). */
export class TextBuffer {
  private buf = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushFn: (text: string) => void,
    private readonly delayMs = 50,
    private readonly maxChars = 32,
  ) {}

  push(text: string): void {
    this.buf += text;
    if (this.buf.length >= this.maxChars) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.buf.length > 0) {
      const part = this.buf.slice(0, 1024);
      this.buf = this.buf.slice(part.length);
      this.flushFn(part);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buf = '';
  }
}

export type KeyLike = { key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Section 5.2: `os.key` for named keys, chords with ctrl / alt / meta, and numpad codes; otherwise text. */
export function routeKey(e: KeyLike): 'key' | 'text' {
  if (e.key.length > 1 || e.ctrlKey || e.altKey || e.metaKey || e.code.startsWith('Numpad')) return 'key';
  return 'text';
}

export function modifiersOf(e: Pick<KeyLike, 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>) {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

/** Wheel delta to notches (section 5.1 `os.scroll`): pixels / 100, lines / 1, clamped to -20..20. */
export function wheelNotches(delta: number, deltaMode: number): number {
  const n = deltaMode === 0 ? delta / 100 : deltaMode === 1 ? delta : delta * 3;
  const r = n > 0 ? Math.ceil(n) : Math.floor(n);
  return Math.max(-20, Math.min(20, r));
}

/** Rounds a normalised coordinate to 4 decimals inside [0, 1]. */
export function norm(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}
