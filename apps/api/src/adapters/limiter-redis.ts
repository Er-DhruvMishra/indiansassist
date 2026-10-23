/**
 * Cluster-wide sliding-window limiter on Redis / Valkey (contracts section 6.12, 10.2; prd-F2): one sorted set per
 * key (`ia:rl:<key>`, member = unique hit id, score = ms), trimmed, counted and appended atomically by one script,
 * so per-IP / per-user / per-token limits hold across every api replica. Selected with PRESENCE_DRIVER=redis.
 */
import { randomUUID } from 'node:crypto';
import type { Limiter, LimitResult } from '../limiter.js';
import type { RedisLike } from './presence-redis.js';

/**
 * KEYS[1] = set; ARGV = now, windowMs, limit, member, record ('1' records a hit, '0' only counts).
 * Returns { allowed (1/0) or count, oldest score when refused }.
 */
export const LIMIT_SCRIPT = `local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%d', now - window))
local n = redis.call('ZCARD', KEYS[1])
if ARGV[5] ~= '1' then return {n, 0} end
if n >= tonumber(ARGV[3]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2])}
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, 0}`;

export const limiterKey = (key: string) => `ia:rl:${key}`;

export class RedisLimiter implements Limiter {
  constructor(
    private readonly client: RedisLike,
    private readonly disabled = false,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string, limit: number, windowMs: number): Promise<LimitResult> {
    if (this.disabled) return { allowed: true, retryAfterSec: 0 };
    const t = this.now();
    const r = (await this.client.eval(LIMIT_SCRIPT, 1, limiterKey(key), t, windowMs, limit, randomUUID(), '1')) as [number, number];
    if (Number(r[0]) === 1) return { allowed: true, retryAfterSec: 0 };
    const oldest = Number.isFinite(Number(r[1])) ? Number(r[1]) : t; // an empty set refused by limit 0
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - t) / 1000)) };
  }

  async count(key: string, windowMs: number): Promise<number> {
    const r = (await this.client.eval(LIMIT_SCRIPT, 1, limiterKey(key), this.now(), windowMs, 0, '-', '0')) as [number, number];
    return Number(r[0]);
  }

  async reset(key?: string): Promise<void> {
    if (key !== undefined) await this.client.del(limiterKey(key));
  }
}
