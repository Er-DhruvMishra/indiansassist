/** prd-F2: the Redis/Valkey presence driver against an in-process fake, and the node-safe sweeper on top of it. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, getOrg, getSession, getUser, seedToken } from '@indiansassist/db';
import { buildPresence, channels, MemoryPresence } from '../src/adapters/presence.js';
import { RedisLimiter } from '../src/adapters/limiter-redis.js';
import { RedisPresence, redisKeys } from '../src/adapters/presence-redis.js';
import { Sweeper } from '../src/sweeper.js';
import { FakeRedisServer } from './fake-redis.js';
import { makeApp, signup, type Account, type TestApp } from './helpers.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function node(server: FakeRedisServer, errors: unknown[] = []): RedisPresence {
  return new RedisPresence(server.client(), (err) => errors.push(err));
}

describe('RedisPresence', () => {
  it('keeps the waiting Desk with a TTL and clears it only for the same connection', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    const b = node(srv);
    await a.setTokenWaiting('tok1', { connectionId: 'c1', nodeId: 'n1', knockRequested: true }, 90);
    // Another node sees it (shared store), with the exact shape the memory driver returns.
    expect(await b.getTokenState('tok1')).toEqual({
      waiting: { connectionId: 'c1', nodeId: 'n1', knockRequested: true },
      sessionId: null,
    });
    await b.clearTokenWaiting('tok1', 'c2');
    expect((await a.getTokenState('tok1')).waiting?.connectionId).toBe('c1');
    await b.clearTokenWaiting('tok1', 'c1');
    expect((await a.getTokenState('tok1')).waiting).toBeNull();
    // TTL
    await a.setTokenWaiting('tok1', { connectionId: 'c3', nodeId: 'n1', knockRequested: false }, 90);
    srv.now += 91_000;
    expect((await b.getTokenState('tok1')).waiting).toBeNull();
    // A connection id that is a prefix of another must not clear it.
    await a.setTokenWaiting('tok2', { connectionId: 'c10', nodeId: 'n1', knockRequested: false }, 90);
    await a.clearTokenWaiting('tok2', 'c1');
    expect((await a.getTokenState('tok2')).waiting?.connectionId).toBe('c10');
  });

  it('stores the token -> session pointer independently of the waiting TTL', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    await a.setTokenWaiting('t', { connectionId: 'c', nodeId: 'n', knockRequested: false }, 1);
    await a.setTokenSession('t', 's1');
    srv.now += 5_000;
    expect(await a.getTokenState('t')).toEqual({ waiting: null, sessionId: 's1' });
    await a.setTokenSession('t', null);
    expect((await a.getTokenState('t')).sessionId).toBeNull();
    expect(srv.data.has(redisKeys.session('t'))).toBe(false);
  });

  it('reports a node alive only while its heartbeat key lives', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    const b = node(srv);
    expect(a.multiNode).toBe(true);
    await a.heartbeatNode('node-a', 90);
    expect(await b.isNodeAlive('node-a')).toBe(true);
    expect(await b.isNodeAlive('node-x')).toBe(false);
    srv.now += 89_000;
    expect(await b.isNodeAlive('node-a')).toBe(true);
    srv.now += 2_000;
    expect(await b.isNodeAlive('node-a')).toBe(false);
  });

  it('grants the lease to one holder, refreshes it for that holder and hands it over after the TTL', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    const b = node(srv);
    expect(await a.tryLease('sweeper', 'node-a', 30)).toBe(true);
    expect(await b.tryLease('sweeper', 'node-b', 30)).toBe(false);
    srv.now += 20_000;
    expect(await a.tryLease('sweeper', 'node-a', 30)).toBe(true); // refresh
    srv.now += 20_000;
    expect(await b.tryLease('sweeper', 'node-b', 30)).toBe(false); // still held (refreshed 20 s ago)
    srv.now += 11_000;
    expect(await b.tryLease('sweeper', 'node-b', 30)).toBe(true); // node-a stopped refreshing
    expect(await a.tryLease('sweeper', 'node-a', 30)).toBe(false);
  });

  it('keeps the online Assist registry shared across nodes, per org, with expiry', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    const b = node(srv);
    const mem = new MemoryPresence('n1');
    for (const p of [a, mem]) {
      await p.setAssistOnline({ connectionId: 'c1', userId: 'u1', orgId: 'o1', role: 'technician', nodeId: 'n1' }, 90);
      await p.setAssistOnline({ connectionId: 'c2', userId: 'u2', orgId: 'o2', role: 'org_admin', nodeId: 'n1' }, 1);
    }
    expect(await b.listAssistsOnline('o1')).toEqual([{ connectionId: 'c1', userId: 'u1', orgId: 'o1', role: 'technician', nodeId: 'n1' }]);
    expect(await mem.listAssistsOnline('o1')).toEqual(await b.listAssistsOnline('o1'));
    expect(await b.listAssistsOnline('o2')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1_100)); // entries carry their own wall-clock expiry
    expect(await b.listAssistsOnline('o2')).toEqual([]);
    expect(await mem.listAssistsOnline('o2')).toEqual([]);
    await b.clearAssistOnline('o1', 'c1');
    await mem.clearAssistOnline('o1', 'c1');
    expect(await a.listAssistsOnline('o1')).toEqual([]);
    expect(await mem.listAssistsOnline('o1')).toEqual([]);
  });

  it('limits across nodes with the shared sliding-window limiter', async () => {
    const srv = new FakeRedisServer();
    let now = 1_000_000;
    const a = new RedisLimiter(srv.client(), false, () => now);
    const b = new RedisLimiter(srv.client(), false, () => now);
    expect((await a.hit('ws-upgrade:1.2.3.4', 3, 60_000)).allowed).toBe(true);
    expect((await b.hit('ws-upgrade:1.2.3.4', 3, 60_000)).allowed).toBe(true);
    now += 1_000;
    expect((await a.hit('ws-upgrade:1.2.3.4', 3, 60_000)).allowed).toBe(true);
    const refused = await b.hit('ws-upgrade:1.2.3.4', 3, 60_000);
    expect(refused).toEqual({ allowed: false, retryAfterSec: 59 });
    expect(await a.count('ws-upgrade:1.2.3.4', 60_000)).toBe(3);
    expect((await b.hit('ws-upgrade:5.6.7.8', 3, 60_000)).allowed).toBe(true); // keys are independent
    now += 60_000;
    expect((await b.hit('ws-upgrade:1.2.3.4', 3, 60_000)).allowed).toBe(true);
    await a.reset('ws-upgrade:1.2.3.4');
    expect(await b.count('ws-upgrade:1.2.3.4', 60_000)).toBe(0);
    expect((await new RedisLimiter(srv.client(), true).hit('k', 0, 1_000)).allowed).toBe(true);
  });

  it('delivers JSON pub/sub across nodes and stops after unsubscribe', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    const b = node(srv);
    const got: object[] = [];
    const unsub = await b.subscribe(channels.node('n1'), (m) => got.push(m));
    await a.publish(channels.node('n1'), { t: 'session.ended', sessionId: 's1' });
    await a.publish(channels.node('n2'), { t: 'other' });
    await flush();
    expect(got).toEqual([{ t: 'session.ended', sessionId: 's1' }]);
    await unsub();
    await unsub(); // idempotent
    await a.publish(channels.node('n1'), { t: 'late' });
    await flush();
    expect(got).toHaveLength(1);
  });

  it('isolates a throwing subscriber and ignores malformed payloads', async () => {
    const srv = new FakeRedisServer();
    const errors: unknown[] = [];
    const a = node(srv, errors);
    const got: object[] = [];
    await a.subscribe('c', () => {
      throw new Error('boom');
    });
    await a.subscribe('c', (m) => got.push(m));
    srv.deliver('c', 'not json');
    await a.publish('c', { ok: 1 });
    await flush();
    expect(got).toEqual([{ ok: 1 }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('surfaces command failures to the caller and quits both connections on close', async () => {
    const srv = new FakeRedisServer();
    const a = node(srv);
    srv.failWith = new Error('ECONNREFUSED');
    await expect(a.isNodeAlive('x')).rejects.toThrow('ECONNREFUSED');
    srv.failWith = null;
    await a.close();
    await expect(a.heartbeatNode('x', 90)).rejects.toThrow();
  });

  it('buildPresence picks the driver and refuses redis without a URL', () => {
    expect(buildPresence('memory', 'n')).toBeInstanceOf(MemoryPresence);
    expect(() => buildPresence('redis', 'n')).toThrow(/REDIS_URL/);
  });
});

describe('sweeper on the redis driver (node-safe N4)', () => {
  let t: TestApp;
  let admin: Account;
  beforeAll(async () => {
    t = await makeApp();
    admin = await signup(t.app);
  });
  afterAll(async () => {
    await t.close();
  });

  async function liveSessionOn(nodeId: string): Promise<string> {
    const org = (await getOrg(t.db, admin.org.id))!;
    const user = (await getUser(t.db, admin.user.id))!;
    const tok = await seedToken(t.db, org, user);
    const s = await createSession(t.db, {
      orgId: org.id, tokenId: tok.id, assistUserId: user.id, deskRef: crypto.randomUUID(),
      tier: 'p1_browser', region: 'in-mum', nodeId,
    });
    return s.id;
  }

  it('ends a peer node\'s sessions only after its heartbeat expired, on the lease holder only', async () => {
    const srv = new FakeRedisServer();
    const own = node(srv); // this node: test-node
    const peer = node(srv);
    const sid = await liveSessionOn('peer-node');
    await own.heartbeatNode('test-node', 90);
    await peer.heartbeatNode('peer-node', 90);
    const sweeper = new Sweeper({ ...t.ctx, presence: own });
    await sweeper.runOnce();
    expect((await getSession(t.db, sid))?.state).toBe('knocked');

    // The peer holds the lease: this node does not sweep at all, even with the peer gone.
    await own.close();
    const own2 = node(srv);
    srv.data.delete(redisKeys.lease('sweeper'));
    expect(await peer.tryLease('sweeper', 'peer-node', 30)).toBe(true);
    srv.now += 91_000; // peer heartbeat expired, peer lease expired too (30 s)
    await own2.heartbeatNode('test-node', 90);
    expect(await peer.tryLease('sweeper', 'peer-node', 30)).toBe(true); // peer re-took it just now
    await new Sweeper({ ...t.ctx, presence: own2 }).runOnce();
    expect((await getSession(t.db, sid))?.state).toBe('knocked');

    // Lease free again: this node sweeps and ends the dead peer's session.
    srv.now += 31_000;
    await own2.heartbeatNode('test-node', 90);
    await new Sweeper({ ...t.ctx, presence: own2 }).runOnce();
    expect(await getSession(t.db, sid)).toMatchObject({ state: 'ended', endReason: 'error' });
  });

  it('skips the lost-node pass when its own heartbeat is missing (presence store flushed)', async () => {
    const srv = new FakeRedisServer();
    const own = node(srv);
    const sid = await liveSessionOn('other-node');
    // Nothing in the store: every node looks lost, including this one.
    await new Sweeper({ ...t.ctx, presence: own }).runOnce();
    expect((await getSession(t.db, sid))?.state).toBe('knocked');
    expect(await own.isNodeAlive('test-node')).toBe(true); // heartbeat rewritten
    // other-node really is gone: the next pass ends its session.
    await new Sweeper({ ...t.ctx, presence: own }).runOnce();
    expect(await getSession(t.db, sid)).toMatchObject({ state: 'ended', endReason: 'error' });
  });
});
