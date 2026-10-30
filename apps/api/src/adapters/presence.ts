/**
 * Presence adapter (contracts section 10.2). The in-memory driver is the single-node dev default: token waiting
 * entries with TTL, the token -> session pointer, the online Assist registry, node heartbeats (`isNodeAlive` is true
 * only for the own node), a lease that is always held and synchronous local pub/sub. The Redis/Valkey driver
 * (`presence-redis.ts`) implements the same interface across nodes, and the signaling bridge (signal/bridge.ts) runs
 * on top of it (prd-F2).
 */
import type { UserRole } from '@indiansassist/shared';
import { createRedisPresence } from './presence-redis.js';

export type TokenWaiting = { connectionId: string; nodeId: string; knockRequested: boolean };

/** One helloed Assist socket, enough to evaluate "knock accept / deny" (`canActOnToken`) on any node. */
export type AssistOnline = { connectionId: string; userId: string; orgId: string; role: UserRole; nodeId: string };

export interface Presence {
  /** True when the driver sees every node of the cluster (heartbeats); false for the single-node memory driver. */
  readonly multiNode: boolean;
  setTokenWaiting(tokenId: string, info: TokenWaiting, ttlSeconds: number): Promise<void>;
  clearTokenWaiting(tokenId: string, connectionId: string): Promise<void>;
  getTokenState(tokenId: string): Promise<{ waiting: TokenWaiting | null; sessionId: string | null }>;
  setTokenSession(tokenId: string, sessionId: string | null): Promise<void>;
  /** Registers (or refreshes) a helloed Assist socket for `ttlSeconds`. */
  setAssistOnline(info: AssistOnline, ttlSeconds: number): Promise<void>;
  clearAssistOnline(orgId: string, connectionId: string): Promise<void>;
  /** Every unexpired Assist socket of the org, on every node. */
  listAssistsOnline(orgId: string): Promise<AssistOnline[]>;
  heartbeatNode(nodeId: string, ttlSeconds: number): Promise<void>;
  isNodeAlive(nodeId: string): Promise<boolean>;
  /**
   * Single-holder lease `name` for `ttlSeconds` (taken when free, refreshed when `holder` already has it). The
   * sweeper runs only on the lease holder (section 7.6 N4). The memory driver always grants it.
   */
  tryLease(name: string, holder: string, ttlSeconds: number): Promise<boolean>;
  /** Phase C section 2.2: a plain key with a TTL (grants, desk codes, hand-overs). */
  setKey(key: string, value: string, ttlSeconds: number): Promise<void>;
  getKey(key: string): Promise<string | null>;
  delKey(key: string): Promise<void>;
  /** Atomic get-and-delete: of two racing callers exactly one gets the value (Valkey GETDEL / EVAL). */
  consume(key: string): Promise<string | null>;
  /** Atomic counter (INCR + EXPIRE NX): the new value; the TTL is set by the first increment only. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  publish(channel: string, message: object): Promise<void>;
  /** Returns the unsubscribe function. */
  subscribe(channel: string, handler: (message: object) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/**
 * Channel names of section 10.2: `cluster` carries org / user / token scoped events to every node, `node:<nodeId>`
 * the frames between a session's owner node and the node holding a participant's socket (section 7.6 N1). Both are
 * subscribed once at boot, so no message can race a subscription.
 */
export const channels = {
  cluster: 'cluster',
  node: (nodeId: string) => `node:${nodeId}`,
};

export class MemoryPresence implements Presence {
  readonly multiNode: boolean = false;
  private readonly waiting = new Map<string, { info: TokenWaiting; expiresAt: number }>();
  private readonly tokenSession = new Map<string, string>();
  private readonly assists = new Map<string, Map<string, { info: AssistOnline; expiresAt: number }>>();
  private readonly subs = new Map<string, Set<(m: object) => void>>();
  private readonly kv = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly ownNodeId: string,
    private readonly now: () => number = Date.now,
  ) {}

  async setTokenWaiting(tokenId: string, info: TokenWaiting, ttlSeconds: number): Promise<void> {
    this.waiting.set(tokenId, { info: { ...info }, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async clearTokenWaiting(tokenId: string, connectionId: string): Promise<void> {
    const cur = this.waiting.get(tokenId);
    if (cur && cur.info.connectionId === connectionId) this.waiting.delete(tokenId);
  }

  async getTokenState(tokenId: string): Promise<{ waiting: TokenWaiting | null; sessionId: string | null }> {
    const cur = this.waiting.get(tokenId);
    let waiting: TokenWaiting | null = null;
    if (cur && cur.expiresAt > this.now()) waiting = { ...cur.info };
    else if (cur) this.waiting.delete(tokenId);
    return { waiting, sessionId: this.tokenSession.get(tokenId) ?? null };
  }

  async setTokenSession(tokenId: string, sessionId: string | null): Promise<void> {
    if (sessionId === null) this.tokenSession.delete(tokenId);
    else this.tokenSession.set(tokenId, sessionId);
  }

  async setAssistOnline(info: AssistOnline, ttlSeconds: number): Promise<void> {
    let org = this.assists.get(info.orgId);
    if (!org) this.assists.set(info.orgId, (org = new Map()));
    org.set(info.connectionId, { info: { ...info }, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async clearAssistOnline(orgId: string, connectionId: string): Promise<void> {
    const org = this.assists.get(orgId);
    org?.delete(connectionId);
    if (org && org.size === 0) this.assists.delete(orgId);
  }

  async listAssistsOnline(orgId: string): Promise<AssistOnline[]> {
    const org = this.assists.get(orgId);
    if (!org) return [];
    const now = this.now();
    const out: AssistOnline[] = [];
    for (const [id, e] of org) {
      if (e.expiresAt > now) out.push({ ...e.info });
      else org.delete(id);
    }
    return out;
  }

  async heartbeatNode(): Promise<void> {
    // Single node: the own node is alive while the process runs.
  }

  async isNodeAlive(nodeId: string): Promise<boolean> {
    return nodeId === this.ownNodeId;
  }

  async tryLease(): Promise<boolean> {
    return true;
  }

  private live(key: string): { value: string; expiresAt: number } | null {
    const e = this.kv.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.kv.delete(key);
      return null;
    }
    return e;
  }

  async setKey(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.kv.set(key, { value, expiresAt: this.now() + Math.max(1, ttlSeconds) * 1000 });
  }

  async getKey(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async delKey(key: string): Promise<void> {
    this.kv.delete(key);
  }

  /** Map.get + Map.delete with no await in between: atomic on the event loop. */
  async consume(key: string): Promise<string | null> {
    const e = this.live(key);
    if (!e) return null;
    this.kv.delete(key);
    return e.value;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const e = this.live(key);
    if (e) {
      const n = Number(e.value) + 1;
      e.value = String(n);
      return n;
    }
    this.kv.set(key, { value: '1', expiresAt: this.now() + Math.max(1, ttlSeconds) * 1000 });
    return 1;
  }

  async publish(channel: string, message: object): Promise<void> {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(message);
      } catch {
        // a failing subscriber never breaks the publisher
      }
    }
  }

  async subscribe(channel: string, handler: (message: object) => void): Promise<() => Promise<void>> {
    let set = this.subs.get(channel);
    if (!set) {
      set = new Set();
      this.subs.set(channel, set);
    }
    set.add(handler);
    return async () => {
      const s = this.subs.get(channel);
      s?.delete(handler);
      if (s && s.size === 0) this.subs.delete(channel);
    };
  }

  async close(): Promise<void> {
    this.waiting.clear();
    this.tokenSession.clear();
    this.assists.clear();
    this.subs.clear();
    this.kv.clear();
  }
}

export function buildPresence(
  driver: 'memory' | 'redis',
  nodeId: string,
  opts: { redisUrl?: string; onError?: (err: unknown, where: string) => void } = {},
): Presence {
  if (driver === 'redis') {
    if (!opts.redisUrl) throw new Error('PRESENCE_DRIVER=redis needs REDIS_URL');
    return createRedisPresence(opts.redisUrl, opts.onError);
  }
  return new MemoryPresence(nodeId);
}
