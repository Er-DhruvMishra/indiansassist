/**
 * Redis / Valkey presence driver (contracts section 10.2, prd-F2). Keys:
 *   ia:tok:<tokenId>          waiting Desk of a token, `<connectionId>\n<json TokenWaiting>`, TTL = ttlSeconds
 *   ia:tok:<tokenId>:session  token -> non-ended session pointer (TTL 48 h as a leak guard; cleared on end)
 *   ia:org:<orgId>:assists    hash connectionId -> JSON AssistOnline + `exp` (ms); expired fields are dropped on read,
 *                             the key itself expires 2 x ttl after the last refresh
 *   ia:node:<nodeId>          node heartbeat, TTL 90 s, refreshed every 30 s (section 7.6 N2)
 *   ia:lease:<name>           single-holder lease (the sweeper, section 7.6 N4), TTL ttlSeconds
 * Pub/sub on the section 10.2 channel names through one dedicated subscriber connection; messages are JSON and are
 * delivered to subscribers on every node, this one included. The driver talks to a narrow `RedisLike` surface (the
 * subset of ioredis it uses) so tests can run it against an in-process fake.
 */
import { Redis } from 'ioredis';
import type { AssistOnline, Presence, TokenWaiting } from './presence.js';

/** The ioredis subset this driver uses. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
}

const SESSION_POINTER_TTL_SEC = 48 * 60 * 60;

/** Compare-and-delete: deletes KEYS[1] only when its value starts with `ARGV[1] .. '\n'`. */
export const CLEAR_WAITING_SCRIPT = `local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, string.len(ARGV[1]) + 1) == ARGV[1] .. '\\n' then return redis.call('DEL', KEYS[1]) end
return 0`;

/** Lease: refreshes the TTL when ARGV[1] already holds KEYS[1], else takes it only if free. Returns 1 when held. */
export const LEASE_SCRIPT = `local v = redis.call('GET', KEYS[1])
if v == ARGV[1] then redis.call('EXPIRE', KEYS[1], ARGV[2]) return 1 end
if not v then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 end
return 0`;

export const redisKeys = {
  waiting: (tokenId: string) => `ia:tok:${tokenId}`,
  session: (tokenId: string) => `ia:tok:${tokenId}:session`,
  node: (nodeId: string) => `ia:node:${nodeId}`,
  lease: (name: string) => `ia:lease:${name}`,
  assists: (orgId: string) => `ia:org:${orgId}:assists`,
};

type Handler = (message: object) => void;

export class RedisPresence implements Presence {
  readonly multiNode = true;
  private readonly sub: RedisLike;
  private readonly handlers = new Map<string, Set<Handler>>();
  private closed = false;
  private readonly lastReport = new Map<string, number>();

  constructor(
    /** Command connection; the cluster limiter (limiter-redis.ts) shares it. */
    readonly client: RedisLike,
    private readonly report: (err: unknown, where: string) => void = () => undefined,
    /** The real ioredis instance behind `client` (null for the test fake): the HTTP rate-limit store uses it. */
    readonly native: unknown = null,
  ) {
    this.sub = client.duplicate();
    // ioredis emits 'error' on connection problems; an unhandled 'error' event would crash the process.
    client.on('error', (err) => this.onError(err, 'redis'));
    this.sub.on('error', (err) => this.onError(err, 'redis-subscriber'));
    this.sub.on('message', (channel, raw) => this.dispatch(channel, raw));
  }

  /** Reconnect loops emit an error per attempt: report at most one per 30 s per source. */
  private onError(err: unknown, where: string): void {
    const now = Date.now();
    if (now - (this.lastReport.get(where) ?? 0) < 30_000) return;
    this.lastReport.set(where, now);
    this.report(err, where);
  }

  private dispatch(channel: string, raw: string): void {
    const set = this.handlers.get(channel);
    if (!set || set.size === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      this.onError(err, `bad message on ${channel}`);
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    for (const h of [...set]) {
      try {
        h(msg);
      } catch (err) {
        this.onError(err, `subscriber of ${channel}`);
      }
    }
  }

  async setTokenWaiting(tokenId: string, info: TokenWaiting, ttlSeconds: number): Promise<void> {
    const value = `${info.connectionId}\n${JSON.stringify(info)}`;
    await this.client.set(redisKeys.waiting(tokenId), value, 'EX', Math.max(1, Math.ceil(ttlSeconds)));
  }

  async clearTokenWaiting(tokenId: string, connectionId: string): Promise<void> {
    await this.client.eval(CLEAR_WAITING_SCRIPT, 1, redisKeys.waiting(tokenId), connectionId);
  }

  async getTokenState(tokenId: string): Promise<{ waiting: TokenWaiting | null; sessionId: string | null }> {
    const [raw, sessionId] = await Promise.all([
      this.client.get(redisKeys.waiting(tokenId)),
      this.client.get(redisKeys.session(tokenId)),
    ]);
    return { waiting: parseWaiting(raw), sessionId: sessionId && sessionId !== '' ? sessionId : null };
  }

  async setTokenSession(tokenId: string, sessionId: string | null): Promise<void> {
    if (sessionId === null) await this.client.del(redisKeys.session(tokenId));
    else await this.client.set(redisKeys.session(tokenId), sessionId, 'EX', SESSION_POINTER_TTL_SEC);
  }

  async setAssistOnline(info: AssistOnline, ttlSeconds: number): Promise<void> {
    const ttl = Math.max(1, Math.ceil(ttlSeconds));
    const key = redisKeys.assists(info.orgId);
    await this.client.hset(key, info.connectionId, JSON.stringify({ ...info, exp: Date.now() + ttl * 1000 }));
    await this.client.expire(key, ttl * 2);
  }

  async clearAssistOnline(orgId: string, connectionId: string): Promise<void> {
    await this.client.hdel(redisKeys.assists(orgId), connectionId);
  }

  async listAssistsOnline(orgId: string): Promise<AssistOnline[]> {
    const key = redisKeys.assists(orgId);
    const all = await this.client.hgetall(key);
    const now = Date.now();
    const out: AssistOnline[] = [];
    const stale: string[] = [];
    for (const [field, raw] of Object.entries(all)) {
      const a = parseAssist(raw);
      if (a && a.exp > now) out.push(a.info);
      else stale.push(field);
    }
    if (stale.length > 0) await this.client.hdel(key, ...stale);
    return out;
  }

  async heartbeatNode(nodeId: string, ttlSeconds: number): Promise<void> {
    await this.client.set(redisKeys.node(nodeId), String(Date.now()), 'EX', Math.max(1, Math.ceil(ttlSeconds)));
  }

  async isNodeAlive(nodeId: string): Promise<boolean> {
    return (await this.client.exists(redisKeys.node(nodeId))) > 0;
  }

  async tryLease(name: string, holder: string, ttlSeconds: number): Promise<boolean> {
    const r = await this.client.eval(LEASE_SCRIPT, 1, redisKeys.lease(name), holder, Math.max(1, Math.ceil(ttlSeconds)));
    return Number(r) === 1;
  }

  async publish(channel: string, message: object): Promise<void> {
    await this.client.publish(channel, JSON.stringify(message));
  }

  async subscribe(channel: string, handler: Handler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler);
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      const s = this.handlers.get(channel);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) {
        this.handlers.delete(channel);
        if (!this.closed) await this.sub.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    await Promise.allSettled([this.sub.quit(), this.client.quit()]);
  }
}

function parseWaiting(raw: string | null): TokenWaiting | null {
  if (!raw) return null;
  const nl = raw.indexOf('\n');
  if (nl === -1) return null;
  try {
    const v = JSON.parse(raw.slice(nl + 1)) as Partial<TokenWaiting>;
    if (typeof v.connectionId !== 'string' || typeof v.nodeId !== 'string') return null;
    return { connectionId: v.connectionId, nodeId: v.nodeId, knockRequested: v.knockRequested === true };
  } catch {
    return null;
  }
}

function parseAssist(raw: string): { info: AssistOnline; exp: number } | null {
  try {
    const v = JSON.parse(raw) as Partial<AssistOnline> & { exp?: unknown };
    if (typeof v.connectionId !== 'string' || typeof v.userId !== 'string' || typeof v.orgId !== 'string') return null;
    if (typeof v.role !== 'string' || typeof v.nodeId !== 'string' || typeof v.exp !== 'number') return null;
    return {
      info: { connectionId: v.connectionId, userId: v.userId, orgId: v.orgId, role: v.role, nodeId: v.nodeId },
      exp: v.exp,
    };
  } catch {
    return null;
  }
}

/** Production constructor: one ioredis connection for commands (the subscriber is a duplicate of it). */
export function createRedisPresence(url: string, onError?: (err: unknown, where: string) => void): RedisPresence {
  const client = new Redis(url, { maxRetriesPerRequest: 3, enableAutoPipelining: false });
  return new RedisPresence(client as unknown as RedisLike, onError, client);
}
