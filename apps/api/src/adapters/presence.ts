/**
 * Presence adapter (contracts section 10.2). The in-memory driver is the single-node dev default: token waiting
 * entries with TTL, the token -> session pointer, node heartbeats (`isNodeAlive` is true only for the own node) and
 * synchronous local pub/sub. A Redis/Valkey driver implements the same interface with keys `ia:tok:<tokenId>` and
 * `ia:node:<id>` (TTL) and pub/sub on the same channel names; it is not shipped in this step (no Redis on the build
 * box), and `buildPresence` refuses `redis` until it is.
 */

export type TokenWaiting = { connectionId: string; nodeId: string; knockRequested: boolean };

export interface Presence {
  setTokenWaiting(tokenId: string, info: TokenWaiting, ttlSeconds: number): Promise<void>;
  clearTokenWaiting(tokenId: string, connectionId: string): Promise<void>;
  getTokenState(tokenId: string): Promise<{ waiting: TokenWaiting | null; sessionId: string | null }>;
  setTokenSession(tokenId: string, sessionId: string | null): Promise<void>;
  heartbeatNode(nodeId: string, ttlSeconds: number): Promise<void>;
  isNodeAlive(nodeId: string): Promise<boolean>;
  publish(channel: string, message: object): Promise<void>;
  /** Returns the unsubscribe function. */
  subscribe(channel: string, handler: (message: object) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Channel names of section 10.2. */
export const channels = {
  orgKnocks: (orgId: string) => `org:${orgId}:knocks`,
  session: (sessionId: string) => `session:${sessionId}`,
  user: (userId: string) => `user:${userId}`,
};

export class MemoryPresence implements Presence {
  private readonly waiting = new Map<string, { info: TokenWaiting; expiresAt: number }>();
  private readonly tokenSession = new Map<string, string>();
  private readonly subs = new Map<string, Set<(m: object) => void>>();

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

  async heartbeatNode(): Promise<void> {
    // Single node: the own node is alive while the process runs.
  }

  async isNodeAlive(nodeId: string): Promise<boolean> {
    return nodeId === this.ownNodeId;
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
    this.subs.clear();
  }
}

export function buildPresence(driver: 'memory' | 'redis', nodeId: string): Presence {
  if (driver === 'redis')
    throw new Error('PRESENCE_DRIVER=redis is not implemented in this build; use memory (single node)');
  return new MemoryPresence(nodeId);
}
