/**
 * `ctl.req` sender of the P2 console (Phase B 5.1, 5.4, 3.7, 4.6): request ids and `opId`, one response per request
 * with the 10 s / 65 s timeouts, the client-side general bucket (30 / s, burst 60), pointer-move and wheel
 * coalescing, the WS `control.relay` fallback while `ia.control` is down, de-duplication of replies and events, and
 * the console's own audit reports (`POST /sessions/:id/events`, posted when the request is sent, retried 3 times).
 */
import {
  LIMITS,
  controlMessageSchema,
  controlRequestSchema,
  opIdFor,
  type ControlErrorCode,
  type ControlEvent,
  type ControlOp,
  type ControlRequest,
} from '@indiansassist/shared';
import { uuid } from '../../../lib/ids';
import { inputKind, reportFor, type ConsoleReport, type KeyArgs, type PointerArgs } from './controlBuilders';

export type ControlResult = { ok: true; result: Record<string, unknown> } | { ok: false; code: ControlErrorCode; message: string };
export type InputReport = { action: 'control.input'; data: { mode: 'dom' | 'debugger'; tabId: number; count: number; kinds: string[]; windowMs: number } };
export type AnyReport = ConsoleReport | InputReport;

export type ControlClientDeps = {
  sessionId: string;
  /** Sends on `ia.control`; false when the channel is not open. */
  sendDc: (msg: ControlRequest) => boolean;
  /** Sends WS `control.relay`; omitted / false when the org refuses relay or the socket is down. */
  sendRelay?: (msg: ControlRequest) => boolean;
  report: (r: AnyReport) => Promise<unknown>;
  onEvent?: (e: ControlEvent) => void;
  onUnreported?: (count: number) => void;
  now?: () => number;
  newId?: () => string;
};

type Pending = { op: ControlOp; resolve: (r: ControlResult) => void; timer: ReturnType<typeof setTimeout>; sentAt: number; move: boolean };
type Agg = { mode: 'dom' | 'debugger'; tabId: number; count: number; kinds: Set<string>; start: number; timer: ReturnType<typeof setTimeout> };

const LONG_OPS: readonly ControlOp[] = ['level.request', 'mask.request', 'mirror.attach'];
const DEDUPE_MS = 30_000;
const MOVE_INTERVAL_MS = 1000 / LIMITS.pointerMovesPerSec;
const WHEEL_INTERVAL_MS = 1000 / 20;
const RELAY_INPUT_INTERVAL_MS = 1000 / 5;
const MOVE_STALL_MS = 300;
const REPORT_RETRIES = 3;

/** Client-side token bucket (mirrors the extension's general bucket so the console never provokes `rate_limited`). */
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(
    private readonly perSec: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.at = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSec);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class ControlClient {
  private readonly pending = new Map<string, Pending>();
  private readonly seenEvents = new Map<string, number>();
  private readonly aggs = new Map<string, Agg>();
  private readonly bucket: TokenBucket;
  private readonly now: () => number;
  private lastMoveAt = -Infinity;
  private lastWheelAt = -Infinity;
  private queuedMove: { args: PointerArgs; timer: ReturnType<typeof setTimeout> } | null = null;
  private disposed = false;
  /** The input mode in force for the focused tab (`ctl.event debugger` switches it). */
  inputMode: 'dom' | 'debugger' = 'dom';
  /** Reports that failed after every retry (shown as "N requests not reported"). */
  unreported = 0;
  /** True while the last request went over the WS relay. */
  viaRelay = false;

  constructor(private readonly deps: ControlClientDeps) {
    this.now = deps.now ?? Date.now;
    this.bucket = new TokenBucket(LIMITS.controlOpsPerSec, LIMITS.controlOpsBurst, this.now);
  }

  opIdOf(reqId: string): string {
    return opIdFor(this.deps.sessionId, reqId);
  }

  /** Builds, validates and sends one request; resolves with its single response (or a local error / timeout). */
  request<O extends ControlOp>(op: O, args: Record<string, unknown>, opts: { skipBucket?: boolean } = {}): Promise<ControlResult> {
    if (this.disposed) return Promise.resolve({ ok: false, code: 'internal', message: 'session closed' });
    const id = (this.deps.newId ?? uuid)().slice(0, 40);
    const parsed = controlRequestSchema.safeParse({ t: 'ctl.req', id, op, args, ts: this.now() });
    if (!parsed.success) return Promise.resolve({ ok: false, code: 'bad_args', message: parsed.error.issues[0]?.message ?? 'invalid arguments' });
    const move = op === 'input.pointer' && args.kind === 'move';
    if (!move && !opts.skipBucket && !this.bucket.take()) return Promise.resolve({ ok: false, code: 'rate_limited', message: 'too many requests; slow down' });
    const msg = parsed.data as ControlRequest;
    const viaDc = this.deps.sendDc(msg);
    const sent = viaDc || (this.deps.sendRelay?.(msg) ?? false);
    if (!sent) return Promise.resolve({ ok: false, code: 'internal', message: 'not connected to the Desk' });
    this.viaRelay = !viaDc;
    this.reportSent(op, args, id);
    const timeoutMs = LONG_OPS.includes(op) ? LIMITS.promptRequestTimeoutMs : LIMITS.controlRequestTimeoutMs;
    return new Promise<ControlResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'timeout', message: 'the Desk did not answer in time' });
      }, timeoutMs);
      this.pending.set(id, { op, resolve, timer, sentAt: this.now(), move });
    });
  }

  private reportSent(op: ControlOp, args: Record<string, unknown>, reqId: string): void {
    const kind = inputKind(op);
    if (kind) return this.aggregate(Number(args.tabId), kind);
    const r = reportFor(op, args, this.opIdOf(reqId));
    if (r) void this.post(r);
  }

  private async post(r: AnyReport, attempt = 0): Promise<void> {
    if (this.disposed && attempt > 0) return;
    try {
      await this.deps.report(r);
    } catch {
      if (attempt + 1 >= REPORT_RETRIES) {
        this.unreported += 1;
        this.deps.onUnreported?.(this.unreported);
        return;
      }
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      await this.post(r, attempt + 1);
    }
  }

  /** `control.input` is aggregated per `(tabId, mode)` over 10 s like the extension's (section 3.7). */
  private aggregate(tabId: number, kind: string): void {
    const mode = this.inputMode;
    const key = `${tabId}:${mode}`;
    let a = this.aggs.get(key);
    if (!a) {
      const timer = setTimeout(() => this.flushAgg(key), LIMITS.controlInputAggregateMs);
      a = { mode, tabId, count: 0, kinds: new Set(), start: this.now(), timer };
      this.aggs.set(key, a);
    }
    a.count += 1;
    a.kinds.add(kind);
  }

  private flushAgg(key: string): void {
    const a = this.aggs.get(key);
    if (!a) return;
    clearTimeout(a.timer);
    this.aggs.delete(key);
    const windowMs = Math.max(1, Math.min(LIMITS.controlInputAggregateMs, Math.round(this.now() - a.start)));
    void this.post({ action: 'control.input', data: { mode: a.mode, tabId: a.tabId, count: a.count, kinds: [...a.kinds], windowMs } });
  }

  /** Flushes every open `control.input` window (session end, mode switch). */
  flushInputs(): void {
    for (const key of [...this.aggs.keys()]) this.flushAgg(key);
  }

  // ---------- coalesced input ----------

  private moveStalled(): boolean {
    const at = this.now();
    for (const p of this.pending.values()) if (p.move && at - p.sentAt > MOVE_STALL_MS) return true;
    return false;
  }

  /** Pointer input: moves at most 30 / s (5 / s over relay), the newest replacing a queued one; others sent at once. */
  pointer(args: PointerArgs): Promise<ControlResult> | null {
    if (args.kind !== 'move') {
      if (args.kind === 'wheel') {
        const gap = this.viaRelay ? RELAY_INPUT_INTERVAL_MS : WHEEL_INTERVAL_MS;
        if (this.now() - this.lastWheelAt < gap) return null;
        this.lastWheelAt = this.now();
      }
      return this.request('input.pointer', args);
    }
    if (this.moveStalled()) return null;
    const gap = this.viaRelay ? RELAY_INPUT_INTERVAL_MS : MOVE_INTERVAL_MS;
    const wait = this.lastMoveAt + gap - this.now();
    if (wait <= 0) {
      this.lastMoveAt = this.now();
      return this.request('input.pointer', args);
    }
    if (this.queuedMove) this.queuedMove.args = args;
    else {
      const timer = setTimeout(() => {
        const q = this.queuedMove;
        this.queuedMove = null;
        if (!q || this.moveStalled()) return;
        this.lastMoveAt = this.now();
        void this.request('input.pointer', q.args);
      }, wait);
      this.queuedMove = { args, timer };
    }
    return null;
  }

  key(args: KeyArgs): Promise<ControlResult> {
    return this.request('input.key', args);
  }

  scroll(args: { tabId: number; nodeId: number | null; dx: number; dy: number }): Promise<ControlResult> | null {
    const gap = this.viaRelay ? RELAY_INPUT_INTERVAL_MS : WHEEL_INTERVAL_MS;
    if (this.now() - this.lastWheelAt < gap) return null;
    this.lastWheelAt = this.now();
    return this.request('input.scroll', args);
  }

  // ---------- inbound ----------

  /** A message from `ia.control` or `control.relay`; wrong-direction and duplicate messages are dropped. */
  handle(raw: unknown): void {
    const p = controlMessageSchema.safeParse(raw);
    if (!p.success) return;
    const m = p.data;
    if (m.t === 'ctl.req') return;
    if (m.t === 'ctl.res') {
      const pend = this.pending.get(m.id);
      if (!pend) return;
      clearTimeout(pend.timer);
      this.pending.delete(m.id);
      pend.resolve(m.ok ? { ok: true, result: m.result } : { ok: false, code: m.error.code, message: m.error.message });
      return;
    }
    const at = this.now();
    for (const [k, t] of this.seenEvents) if (at - t > DEDUPE_MS) this.seenEvents.delete(k);
    const key = `${m.kind}:${m.ts}:${'tabId' in m ? m.tabId : ''}`;
    if (this.seenEvents.has(key)) return;
    this.seenEvents.set(key, at);
    if (m.kind === 'debugger') {
      const next = m.attached ? 'debugger' : 'dom';
      if (next !== this.inputMode) {
        this.flushInputs();
        this.inputMode = next;
      }
    }
    this.deps.onEvent?.(m);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    this.flushInputs();
    this.disposed = true;
    if (this.queuedMove) clearTimeout(this.queuedMove.timer);
    this.queuedMove = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, code: 'internal', message: 'session closed' });
      this.pending.delete(id);
    }
  }
}
