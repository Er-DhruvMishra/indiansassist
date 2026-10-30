/**
 * In-process stand-in for the ioredis surface `RedisPresence` uses (`RedisLike`): one `FakeRedisServer` holds the
 * keyspace (with TTLs on an injectable clock) and the pub/sub bus; every `client()` / `duplicate()` is a connection
 * to it. `eval` understands exactly the scripts the drivers ship (presence and limiter) and emulates them atomically.
 */
import { LIMIT_SCRIPT } from '../src/adapters/limiter-redis.js';
import { CLEAR_WAITING_SCRIPT, CONSUME_SCRIPT, INCR_SCRIPT, LEASE_SCRIPT, type RedisLike } from '../src/adapters/presence-redis.js';

type Entry = { value: string; expiresAt: number | null; hash?: Map<string, string>; zset?: Map<string, number> };

export class FakeRedisServer {
  readonly data = new Map<string, Entry>();
  private readonly subscribers = new Map<string, Set<FakeRedisClient>>();
  now = Date.now();
  /** When set, every command rejects with it (connection down). */
  failWith: Error | null = null;

  live(key: string): Entry | null {
    const e = this.data.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= this.now) {
      this.data.delete(key);
      return null;
    }
    return e;
  }

  client(): FakeRedisClient {
    return new FakeRedisClient(this);
  }

  addSub(channel: string, c: FakeRedisClient): void {
    let s = this.subscribers.get(channel);
    if (!s) this.subscribers.set(channel, (s = new Set()));
    s.add(c);
  }

  removeSub(channel: string, c: FakeRedisClient): void {
    this.subscribers.get(channel)?.delete(c);
  }

  /** Delivers asynchronously, like a real server round trip. */
  deliver(channel: string, message: string): number {
    const subs = [...(this.subscribers.get(channel) ?? [])];
    for (const c of subs) queueMicrotask(() => c.emitMessage(channel, message));
    return subs.length;
  }
}

export class FakeRedisClient implements RedisLike {
  private readonly messageListeners: ((channel: string, message: string) => void)[] = [];
  readonly errorListeners: ((err: Error) => void)[] = [];
  quitted = false;

  constructor(private readonly server: FakeRedisServer) {}

  private async run<T>(fn: () => T): Promise<T> {
    if (this.quitted) throw new Error('Connection is closed.');
    if (this.server.failWith) throw this.server.failWith;
    return fn();
  }

  get(key: string): Promise<string | null> {
    return this.run(() => this.server.live(key)?.value ?? null);
  }

  set(key: string, value: string, _mode: 'EX', seconds: number): Promise<unknown> {
    return this.run(() => {
      this.server.data.set(key, { value, expiresAt: this.server.now + seconds * 1000 });
      return 'OK';
    });
  }

  del(key: string): Promise<number> {
    return this.run(() => (this.server.live(key) && this.server.data.delete(key) ? 1 : 0));
  }

  exists(key: string): Promise<number> {
    return this.run(() => (this.server.live(key) ? 1 : 0));
  }

  expire(key: string, seconds: number): Promise<number> {
    return this.run(() => {
      const e = this.server.live(key);
      if (!e) return 0;
      e.expiresAt = this.server.now + seconds * 1000;
      return 1;
    });
  }

  hset(key: string, field: string, value: string): Promise<number> {
    return this.run(() => {
      let e = this.server.live(key);
      if (!e) this.server.data.set(key, (e = { value: '', expiresAt: null, hash: new Map() }));
      if (!e.hash) throw new Error('WRONGTYPE');
      const added = e.hash.has(field) ? 0 : 1;
      e.hash.set(field, value);
      return added;
    });
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    return this.run(() => {
      const e = this.server.live(key);
      if (!e?.hash) return 0;
      let n = 0;
      for (const f of fields) if (e.hash.delete(f)) n++;
      if (e.hash.size === 0) this.server.data.delete(key);
      return n;
    });
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return this.run(() => Object.fromEntries(this.server.live(key)?.hash ?? new Map<string, string>()));
  }

  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.run(() => {
      if (numKeys !== 1) throw new Error('fake eval supports one key');
      const key = String(args[0]);
      const cur = this.server.live(key);
      if (script === CLEAR_WAITING_SCRIPT) {
        const prefix = `${String(args[1])}\n`;
        if (cur && cur.value.startsWith(prefix)) {
          this.server.data.delete(key);
          return 1;
        }
        return 0;
      }
      if (script === LIMIT_SCRIPT) {
        const [, now, windowMs, limit, member, record] = args.map(String);
        let e = cur;
        if (!e) e = { value: '', expiresAt: null, zset: new Map() };
        const z = e.zset!;
        for (const [m, score] of z) if (score <= Number(now) - Number(windowMs)) z.delete(m);
        if (record !== '1') return [z.size, 0];
        if (z.size >= Number(limit)) return [0, Math.min(...z.values())];
        z.set(member!, Number(now));
        e.expiresAt = this.server.now + Number(windowMs);
        this.server.data.set(key, e);
        return [1, 0];
      }
      if (script === CONSUME_SCRIPT) {
        if (!cur) return null;
        this.server.data.delete(key);
        return cur.value;
      }
      if (script === INCR_SCRIPT) {
        if (cur) {
          cur.value = String(Number(cur.value) + 1);
          return Number(cur.value);
        }
        this.server.data.set(key, { value: '1', expiresAt: this.server.now + Number(args[1]) * 1000 });
        return 1;
      }
      if (script === LEASE_SCRIPT) {
        const holder = String(args[1]);
        const ttl = Number(args[2]);
        if (cur && cur.value === holder) {
          cur.expiresAt = this.server.now + ttl * 1000;
          return 1;
        }
        if (!cur) {
          this.server.data.set(key, { value: holder, expiresAt: this.server.now + ttl * 1000 });
          return 1;
        }
        return 0;
      }
      throw new Error('unknown script');
    });
  }

  publish(channel: string, message: string): Promise<number> {
    return this.run(() => this.server.deliver(channel, message));
  }

  subscribe(channel: string): Promise<unknown> {
    return this.run(() => this.server.addSub(channel, this));
  }

  unsubscribe(channel: string): Promise<unknown> {
    return this.run(() => this.server.removeSub(channel, this));
  }

  on(event: 'message' | 'error', listener: ((channel: string, message: string) => void) | ((err: Error) => void)): unknown {
    if (event === 'message') this.messageListeners.push(listener as (channel: string, message: string) => void);
    else this.errorListeners.push(listener as (err: Error) => void);
    return this;
  }

  emitMessage(channel: string, message: string): void {
    if (this.quitted) return;
    for (const l of this.messageListeners) l(channel, message);
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.server);
  }

  async quit(): Promise<unknown> {
    this.quitted = true;
    return 'OK';
  }
}
