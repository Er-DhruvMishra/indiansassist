/**
 * Rate primitives of the service worker: the token bucket of the control-op limits (section 5.1: 30 / s burst
 * 60 for ops, a separate 30 / s bucket for pointer moves), the `ctl.req` id de-duplication (section 4.6, 30 s)
 * and the `control.input` aggregation per `(tabId, mode)` over 10 s windows (section 3.6).
 */
import { LIMITS, type InputKind, type InputMode } from '@indiansassist/shared';

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSec: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(n = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** Remembers request ids for `ttlMs`; `seen(id)` is true for a repeat (a request sent over relay and then the DC). */
export class RecentIds {
  private ids = new Map<string, number>();

  constructor(
    private readonly ttlMs = 30000,
    private readonly now: () => number = Date.now,
  ) {}

  seen(id: string): boolean {
    const t = this.now();
    for (const [k, at] of this.ids) if (t - at > this.ttlMs) this.ids.delete(k);
    if (this.ids.has(id)) return true;
    this.ids.set(id, t);
    return false;
  }
}

export type InputAggregate = {
  mode: InputMode;
  tabId: number;
  count: number;
  kinds: InputKind[];
  windowMs: number;
  refused: number;
};

type Bucket = { startedAt: number; count: number; refused: number; kinds: Set<InputKind>; timer: ReturnType<typeof setTimeout> };

/** Aggregates input ops into `control.input` entries (one per `(tabId, mode)` per 10 s window). */
export class InputAggregator {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly emit: (data: InputAggregate) => void,
    private readonly windowMs: number = LIMITS.controlInputAggregateMs,
    private readonly now: () => number = Date.now,
  ) {}

  record(tabId: number, mode: InputMode, kind: InputKind, refused: boolean): void {
    const key = `${tabId}:${mode}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { startedAt: this.now(), count: 0, refused: 0, kinds: new Set(), timer: setTimeout(() => this.flushKey(key), this.windowMs) };
      this.buckets.set(key, b);
    }
    if (refused) b.refused++;
    else b.count++;
    b.kinds.add(kind);
  }

  private flushKey(key: string): void {
    const b = this.buckets.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    this.buckets.delete(key);
    const [tab, mode] = key.split(':') as [string, InputMode];
    this.emit({
      mode,
      tabId: Number(tab),
      count: b.count,
      kinds: [...b.kinds].sort(),
      windowMs: Math.max(0, Math.round(this.now() - b.startedAt)),
      refused: b.refused,
    });
  }

  /** Session end (section 3.4): every open window is flushed now. */
  flushAll(): void {
    for (const key of [...this.buckets.keys()]) this.flushKey(key);
  }
}
