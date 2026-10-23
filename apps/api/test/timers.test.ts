import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, getOrg, getSession, getUser, listAuditBySession, revokeToken, seedToken } from '@indiansassist/db';
import { MemoryPresence } from '../src/adapters/presence.js';
import { Sweeper } from '../src/sweeper.js';
import { call, createToken, listen, makeApp, signup, SignalClient, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let url: string;
let admin: Account;
const clients: SignalClient[] = [];

beforeAll(async () => {
  t = await makeApp({}, { knockTimeoutMs: 400, graceMs: 300, helloTimeoutMs: 300, tickMs: 50 });
  url = await listen(t.app);
  admin = await signup(t.app);
});
afterAll(async () => {
  for (const c of clients) c.close();
  await t.close();
});

async function open(cookie?: string): Promise<SignalClient> {
  const c = await SignalClient.open(url, cookie ? { cookie } : {});
  clients.push(c);
  return c;
}

describe('timers and sweeper (sections 7.2, 7.5, 7.6)', () => {
  it('closes a socket that never says hello with 4408', async () => {
    const c = await open();
    expect(await c.closed(3000)).toBe(4408);
  });

  it('an unanswered knock times out; the Desk socket stays open and the Assist toast is closed', async () => {
    const { compact } = await createToken(t.app, admin);
    const assist = await open(admin.cookie);
    await assist.request({ t: 'assist.hello' }, 'assist.hello.ok');
    const desk = await open();
    await desk.request({ t: 'desk.hello', token: compact }, 'desk.hello.ok');
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    expect((await assist.next('knock.closed', (m) => m.sessionId === sessionId, 3000)).by).toBe('timeout');
    expect(await desk.next('session.ended', () => true, 3000)).toMatchObject({ endReason: 'timeout', reachedActive: false });
    expect(desk.closeCode).toBeNull();
    // Try again: a new knock on the same token works.
    const again = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    expect(again.sessionId).not.toBe(sessionId);
    assist.send({ t: 'assist.deny', sessionId: again.sessionId });
    await desk.next('session.ended', (m) => m.sessionId === again.sessionId);
  });

  it('a Desk that drops out of an active session ends it desk_left after the grace period', async () => {
    const { compact } = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed' });
    const assist = await open(admin.cookie);
    await assist.request({ t: 'assist.hello' }, 'assist.hello.ok');
    const desk = await open();
    await desk.request({ t: 'desk.hello', token: compact }, 'desk.hello.ok');
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.request({ t: 'desk.consent', state: 'granted' }, 'consent.ok');
    desk.close();
    const ended = await assist.next('session.ended', (m) => m.sessionId === sessionId, 3000);
    expect(ended).toMatchObject({ endReason: 'desk_left', reachedActive: true });
    const actions = (await listAuditBySession(t.db, sessionId as string)).map((e) => e.action);
    expect(actions.at(-1)).toBe('session.ended');
    // timed tokens stay active for the next session
    const tokens = (await call(t.app, '/api/v1/tokens?status=active', { cookie: admin.cookie })).json();
    expect(tokens.items.length).toBeGreaterThan(0);
  });

  it('the sweeper ends sessions past their deadline and sessions owned by a lost node', async () => {
    const org = (await getOrg(t.db, admin.org.id))!;
    const user = (await getUser(t.db, admin.user.id))!;
    const tok1 = await seedToken(t.db, org, user);
    const tok2 = await seedToken(t.db, org, user);
    const past = new Date(Date.now() - 10_000);
    const late = await createSession(t.db, {
      orgId: org.id, tokenId: tok1.id, assistUserId: user.id, deskRef: '0f0e0d0c-0b0a-4908-8706-050403020100',
      tier: 'p1_browser', region: 'in-mum', nodeId: 'test-node', knockedAt: past, knockExpiresAt: new Date(Date.now() - 1000),
    });
    const orphan = await createSession(t.db, {
      orgId: org.id, tokenId: tok2.id, assistUserId: user.id, deskRef: '1f0e0d0c-0b0a-4908-8706-050403020100',
      tier: 'p1_browser', region: 'in-mum', nodeId: 'gone-node',
    });
    // The single-node memory driver cannot see other nodes: it never ends their sessions (prd-F2).
    await new Sweeper(t.ctx).runOnce();
    expect(await getSession(t.db, late.id)).toMatchObject({ state: 'ended', endReason: 'timeout' });
    expect((await getSession(t.db, orphan.id))?.state).toBe('knocked');
    // A cluster-aware driver reports gone-node as lost.
    class ClusterPresence extends MemoryPresence {
      override readonly multiNode: boolean = true;
    }
    await new Sweeper({ ...t.ctx, presence: new ClusterPresence('test-node') }).runOnce();
    expect(await getSession(t.db, orphan.id)).toMatchObject({ state: 'ended', endReason: 'error' });
    const entries = await listAuditBySession(t.db, orphan.id);
    expect(entries.map((e) => [e.action, e.actorType])).toEqual([['session.ended', 'system']]);
    expect(entries[0]?.data).toEqual({ endReason: 'error', durationMs: null, path: 'unknown' });
  });

  it('the sweeper ends sessions left live on a revoked token (SEC-09 backstop)', async () => {
    const org = (await getOrg(t.db, admin.org.id))!;
    const user = (await getUser(t.db, admin.user.id))!;
    const tok = await seedToken(t.db, org, user);
    const s = await createSession(t.db, {
      orgId: org.id, tokenId: tok.id, assistUserId: user.id, deskRef: '2f0e0d0c-0b0a-4908-8706-050403020100',
      tier: 'p1_browser', region: 'in-mum', nodeId: 'test-node',
    });
    // Simulates a crash between the revocation commit and the cascade: the token is revoked, the session is not.
    await revokeToken(t.db, tok.id, user.id);
    await new Sweeper(t.ctx).runOnce();
    expect(await getSession(t.db, s.id)).toMatchObject({ state: 'ended', endReason: 'token_revoked' });
  });
});
