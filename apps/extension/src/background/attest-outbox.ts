/**
 * The attestation outbox (section 3.7): every `desk.event` goes through one FIFO per session, drained at 4 / s
 * with a burst of 15 (below the server's 5 / s burst 20). Entries are never dropped, only delayed; the queue is
 * persisted so a worker restart loses nothing; `error rate_limited` re-queues the frame at the head and halves the
 * drain rate for 10 s; `flush()` drains before the frame that ends the session (section 3.4).
 */
import { LIMITS, deskEventSchema, type DeskEventAction } from '@indiansassist/shared';

export type OutboxEntry = {
  id: string;
  sessionId: string;
  action: DeskEventAction;
  data: Record<string, unknown>;
  reason?: string;
};

export type OutboxDeps = {
  /** Sends one `desk.event` frame; false when the socket is not open (the entry stays queued). */
  send: (frame: { t: 'desk.event'; id: string; sessionId: string; action: DeskEventAction; data: Record<string, unknown>; reason?: string }) => boolean;
  persist: (entries: OutboxEntry[]) => void | Promise<void>;
  now?: () => number;
  ratePerSec?: number;
  burst?: number;
};

const SLOW_MS = 10000;
const WINDOW_MS = 1000;

export class AttestOutbox {
  private queue: OutboxEntry[] = [];
  private inflight = new Map<string, OutboxEntry>();
  private sentAt: number[] = [];
  private tokens: number;
  private lastRefill: number;
  private slowUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(private readonly deps: OutboxDeps) {
    this.rate = deps.ratePerSec ?? LIMITS.deskEventOutboxPerSec;
    this.burst = deps.burst ?? LIMITS.deskEventOutboxBurst;
    this.now = deps.now ?? Date.now;
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  get size(): number {
    return this.queue.length + this.inflight.size;
  }

  /** Restores a persisted queue (worker restart); in-flight frames were never acknowledged, so they go first. */
  restore(entries: OutboxEntry[]): void {
    this.queue = [...entries, ...this.queue];
    for (const e of entries) {
      const n = Number(e.id.slice(1));
      if (Number.isFinite(n) && n >= this.seq) this.seq = n + 1;
    }
    this.schedule(0);
  }

  /** Queues one attestation; invalid data is a programming error and is refused (returns false). */
  enqueue(sessionId: string, action: DeskEventAction, data: Record<string, unknown>, reason?: string): boolean {
    const frame = { t: 'desk.event' as const, sessionId, action, data, ...(reason !== undefined ? { reason } : {}) };
    const check = deskEventSchema.safeParse(frame);
    if (!check.success) {
      console.error('[outbox] refusing an invalid desk.event', action, check.error.issues[0]?.message);
      return false;
    }
    this.queue.push({ id: `e${this.seq++}`, sessionId, action, data, ...(reason !== undefined ? { reason } : {}) });
    this.save();
    this.schedule(0);
    return true;
  }

  /** `event.ok` with `re` = the frame id. */
  ack(re: string | undefined): void {
    if (re === undefined || !this.inflight.delete(re)) return;
    this.save();
  }

  /** `error rate_limited` for frame `re`: back to the head of the queue, half rate for 10 s. */
  rateLimited(re: string | undefined): void {
    const e = re !== undefined ? this.inflight.get(re) : undefined;
    if (e) {
      this.inflight.delete(re!);
      this.queue.unshift(e);
    }
    this.slowUntil = this.now() + SLOW_MS;
    this.save();
    this.schedule(1000 / (this.rate / 2));
  }

  /** Any other error for frame `re` (the server refused it): it will never be acknowledged. */
  refused(re: string | undefined): void {
    if (re !== undefined && this.inflight.delete(re)) this.save();
  }

  /** The socket re-opened: frames sent before the drop may be lost, so they are re-sent (the server dedupes file.*). */
  resend(): void {
    if (this.inflight.size > 0) {
      this.queue = [...this.inflight.values(), ...this.queue];
      this.inflight.clear();
      this.save();
    }
    this.schedule(0);
  }

  /** Resolves when the queue is drained and acknowledged, or after `ackWaitMs` past the last send. */
  flush(ackWaitMs = 1000, maxMs = 15000): Promise<void> {
    const started = this.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.queue.length === 0 && this.inflight.size === 0) return resolve();
        if (this.now() - started > maxMs) return resolve();
        if (this.queue.length === 0) {
          const last = this.sentAt[this.sentAt.length - 1] ?? started;
          if (this.now() - last >= ackWaitMs) return resolve();
        }
        setTimeout(check, 50);
      };
      this.schedule(0);
      check();
    });
  }

  clear(): void {
    this.queue = [];
    this.inflight.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  private currentRate(): number {
    return this.now() < this.slowUntil ? this.rate / 2 : this.rate;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.lastRefill) / 1000) * this.currentRate());
    this.lastRefill = t;
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, delayMs);
  }

  private drain(): void {
    this.refill();
    const t = this.now();
    this.sentAt = this.sentAt.filter((s) => t - s < WINDOW_MS);
    while (this.queue.length > 0 && this.tokens >= 1 && this.sentAt.length < this.burst) {
      const e = this.queue[0]!;
      const sent = this.deps.send({ t: 'desk.event', id: e.id, sessionId: e.sessionId, action: e.action, data: e.data, ...(e.reason !== undefined ? { reason: e.reason } : {}) });
      if (!sent) break; // socket down: keep the entry, retry later
      this.queue.shift();
      this.inflight.set(e.id, e);
      this.tokens -= 1;
      this.sentAt.push(t);
    }
    this.save();
    if (this.queue.length > 0) {
      const byToken = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.currentRate()) * 1000;
      const byWindow = this.sentAt.length >= this.burst ? WINDOW_MS - (t - this.sentAt[0]!) : 0;
      this.schedule(Math.max(25, byToken, byWindow));
    }
  }

  private save(): void {
    void this.deps.persist([...this.inflight.values(), ...this.queue]);
  }
}
