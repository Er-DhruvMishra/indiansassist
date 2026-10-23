/**
 * Sliding-window limiter for WS and per-key limits (contracts section 6.12), because `@fastify/rate-limit` does not
 * see WS frames or keys that need an authenticated user. The backend follows PRESENCE_DRIVER: `memory` (this
 * process) or `redis` (adapters/limiter-redis.ts, one sorted set per key, shared by every api replica).
 */

export type LimitResult = { allowed: boolean; retryAfterSec: number };

export interface Limiter {
  /** Records one hit for `key`; returns whether it is allowed within `limit` per `windowMs`. */
  hit(key: string, limit: number, windowMs: number): Promise<LimitResult>;
  /** Hits in the current window without recording one. */
  count(key: string, windowMs: number): Promise<number>;
  reset(key?: string): Promise<void>;
}

export class MemoryLimiter implements Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly disabled = false,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(key: string, windowMs: number): number[] {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  async hit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
    if (this.disabled) return { allowed: true, retryAfterSec: 0 };
    const list = this.prune(key, windowMs);
    if (list.length >= limit) {
      const oldest = list[0]!;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - this.now()) / 1000)) };
    }
    list.push(this.now());
    this.hits.set(key, list);
    return { allowed: true, retryAfterSec: 0 };
  }

  async count(key: string, windowMs: number): Promise<number> {
    return this.prune(key, windowMs).length;
  }

  async reset(key?: string): Promise<void> {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}

/**
 * Short-code failure budget (section 3.3 S3, amended by X12): more than 30 misses in a sliding 60 s window on this node blocks
 * short-code lookups for 5 minutes. Never disabled by RATE_LIMIT_DISABLED (it is an abuse brake, not a rate limit);
 * tests use the `limit` option.
 */
export class ShortCodeBudget {
  private misses: number[] = [];
  private blockedUntil = 0;
  constructor(
    private readonly onExhausted: () => void,
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly blockMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds left of an active block, or 0. */
  blockedFor(): number {
    const left = this.blockedUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  recordMiss(): void {
    const t = this.now();
    this.misses = this.misses.filter((x) => x > t - this.windowMs);
    this.misses.push(t);
    if (this.misses.length > this.limit && this.blockedUntil <= t) {
      this.blockedUntil = t + this.blockMs;
      this.misses = [];
      this.onExhausted();
    }
  }
}

/** Per-connection token bucket (20 frames / s, burst 60). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSec = 20,
    private readonly burst = 60,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
