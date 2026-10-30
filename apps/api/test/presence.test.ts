/** Phase C section 2.2: `Presence.consume` and `Presence.incr` on both drivers, with two concurrent callers. */
import { describe, expect, it } from 'vitest';
import { MemoryPresence, type Presence } from '../src/adapters/presence.js';
import { RedisPresence } from '../src/adapters/presence-redis.js';
import { FakeRedisServer } from './fake-redis.js';

function drivers(): [string, () => { p: Presence; advance: (ms: number) => void }][] {
  return [
    [
      'memory',
      () => {
        let now = Date.now();
        return { p: new MemoryPresence('n1', () => now), advance: (ms) => (now += ms) };
      },
    ],
    [
      'redis',
      () => {
        const server = new FakeRedisServer();
        return { p: new RedisPresence(server.client()), advance: (ms) => (server.now += ms) };
      },
    ],
  ];
}

describe.each(drivers())('Presence %s driver', (_name, make) => {
  it('consume: exactly one of two racing consumers gets the value, then it is gone', async () => {
    const { p } = make();
    await p.setKey('ia:ho:x', 'entry', 120);
    const [a, b] = await Promise.all([p.consume('ia:ho:x'), p.consume('ia:ho:x')]);
    expect([a, b].filter((v) => v === 'entry')).toHaveLength(1);
    expect([a, b].filter((v) => v === null)).toHaveLength(1);
    expect(await p.getKey('ia:ho:x')).toBeNull();
    expect(await p.consume('ia:ho:missing')).toBeNull();
    await p.close();
  });

  it('incr: concurrent increments are all counted; the TTL comes from the first one', async () => {
    const { p, advance } = make();
    const got = await Promise.all([p.incr('ia:dl:g:uses', 120), p.incr('ia:dl:g:uses', 120), p.incr('ia:dl:g:uses', 120)]);
    expect([...got].sort()).toEqual([1, 2, 3]);
    advance(60_000);
    expect(await p.incr('ia:dl:g:uses', 120)).toBe(4);
    advance(61_000);
    expect(await p.incr('ia:dl:g:uses', 120)).toBe(1);
    await p.close();
  });

  it('setKey / getKey / delKey with TTL', async () => {
    const { p, advance } = make();
    await p.setKey('ia:dc:h', 'v', 10);
    expect(await p.getKey('ia:dc:h')).toBe('v');
    advance(11_000);
    expect(await p.getKey('ia:dc:h')).toBeNull();
    await p.setKey('ia:dc:h', 'w', 10);
    await p.delKey('ia:dc:h');
    expect(await p.getKey('ia:dc:h')).toBeNull();
    await p.close();
  });
});
