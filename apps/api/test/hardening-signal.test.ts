/** Regression tests: live socket authority (SEC-02) and token expiry on held knocks (SEC-03 / correctness-F5). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WS_CLOSE } from '@indiansassist/shared';
import { listOpenSessionsByToken, revokeAuthSession } from '@indiansassist/db';
import { addMember, call, cookieOf, createToken, listen, makeApp, PASSWORD, signup, type TestApp } from './helpers.js';
import { Kit, sleep } from './signal-kit.js';

let t: TestApp;
let kit: Kit;

beforeAll(async () => {
  t = await makeApp({}, { tickMs: 50 });
  kit = new Kit(t, await listen(t.app));
});
afterAll(async () => {
  kit.closeAll();
  await t.close();
});

async function login(email: string): Promise<string> {
  const res = await call(t.app, '/api/v1/auth/login', { body: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

describe('SEC-02 Assist socket authority follows the cookie session and the role', () => {
  it('logout closes the sockets opened with that cookie (4401)', async () => {
    const admin = await signup(t.app);
    const a = await kit.assistOnline(admin);
    const out = await call(t.app, '/api/v1/auth/logout', { cookie: admin.cookie, body: {} });
    expect(out.statusCode).toBe(204);
    expect((await a.next('error')).code).toBe('not_authenticated');
    expect(await a.closed()).toBe(4401);
  });

  it('a password change closes every other session socket but keeps the one that changed it', async () => {
    const email = `pw${Date.now()}@example.test`;
    const admin = await signup(t.app, { email });
    const other = await login(email);
    const mine = await kit.assistOnline(admin);
    const theirs = await kit.assistOnline({ ...admin, cookie: other });
    const res = await call(t.app, '/api/v1/auth/password', {
      cookie: admin.cookie,
      body: { currentPassword: PASSWORD, newPassword: 'another long passphrase' },
    });
    expect(res.statusCode).toBe(204);
    expect(await theirs.closed()).toBe(4401);
    expect(await mine.quiet('error', 200)).toBe(true);
    expect(mine.closeCode).toBeNull();
  });

  it('demotion to observer closes the socket 4403; demotion to technician removes org-wide knocks', async () => {
    const admin = await signup(t.app);
    const admin2 = await addMember(t.app, admin, 'org_admin');
    const senior = await addMember(t.app, admin, 'senior_technician');
    const tech = await addMember(t.app, admin, 'technician');
    const a2 = await kit.assistOnline(admin2);
    const res = await call(t.app, `/api/v1/users/${admin2.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'observer' } });
    expect(res.statusCode).toBe(200);
    expect(await a2.closed()).toBe(4403);

    const s = await kit.assistOnline(senior);
    await kit.assistOnline(tech);
    const demote = await call(t.app, `/api/v1/users/${senior.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'technician' } });
    expect(demote.statusCode).toBe(200);
    const { compact } = await createToken(t.app, tech);
    const desk = await kit.deskOnline(compact);
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    // The demoted socket is no longer subscribed to (and cannot act on) a colleague's knock.
    expect(await s.quiet('assist.knock', 300)).toBe(true);
    s.send({ t: 'assist.accept', sessionId });
    expect((await s.next('error')).code).toBe('forbidden');
    expect(s.closeCode).toBeNull();
  });

  it('a cookie session revoked behind the socket is noticed by the periodic re-validation', async () => {
    const t2 = await makeApp({}, { tickMs: 30, authRecheckMs: 100 });
    const kit2 = new Kit(t2, await listen(t2.app));
    try {
      const admin = await signup(t2.app);
      const a = await kit2.assistOnline(admin);
      const me = (await call(t2.app, '/api/v1/auth/me', { cookie: admin.cookie })).json();
      expect(me.user.id).toBe(admin.user.id);
      const p = [...t2.ctx.hub.conns.values()].find((c) => c.principal?.user.id === admin.user.id)!.principal!;
      await revokeAuthSession(t2.db, p.authSession.id);
      expect(await a.closed(2000)).toBe(4401);
    } finally {
      kit2.closeAll();
      await t2.close();
    }
  });
});

describe('SEC-03 / F5 expired tokens never produce a knock', () => {
  it('a held knock is refused when the token expired before a technician came online', async () => {
    const admin = await signup(t.app);
    const { compact, token } = await createToken(t.app, admin);
    const desk = await kit.deskOnline(compact);
    expect((await desk.request({ t: 'desk.knock' }, 'knock.held')).technicianOnline).toBe(false);
    await kit.expireToken(token.id);
    const assist = await kit.assistOnline(admin);
    const gone = await desk.next('error');
    expect(gone).toMatchObject({ code: 'token_gone', details: { status: 'expired' } });
    expect(await desk.closed()).toBe(4403);
    expect(await assist.quiet('assist.knock', 200)).toBe(true);
    expect(await listOpenSessionsByToken(t.db, token.id)).toHaveLength(0);
  });

  it('desk.poll tells a waiting Desk its token expired', async () => {
    const admin = await signup(t.app);
    const { compact, token } = await createToken(t.app, admin);
    const desk = await kit.deskOnline(compact);
    await kit.expireToken(token.id);
    desk.send({ t: 'desk.poll' });
    expect((await desk.next('error')).code).toBe('token_gone');
    expect(await desk.closed()).toBe(4403);
  });

  it('the hub closes a waiting Desk once its token passes expires_at', async () => {
    const admin = await signup(t.app);
    const { compact, token } = await createToken(t.app, admin);
    const desk = await kit.deskOnline(compact);
    const conn = [...t.ctx.hub.conns.values()].find((c) => c.desk?.tokenId === token.id)!;
    conn.desk!.tokenExpiresAt = Date.now() - 1;
    expect((await desk.next('error')).details).toEqual({ status: 'expired' });
    expect(await desk.closed()).toBe(4403);
    await sleep(10);
  });
});

describe('F coordinator item 2: a Desk that died without a close frame is superseded by a re-hello', () => {
  it('the Assist sees and can accept the new Desk knock', async () => {
    const admin = await signup(t.app);
    const { compact, token } = await createToken(t.app, admin);
    const assist = await kit.assistOnline(admin);
    const desk1 = await kit.deskOnline(compact);
    const knock1 = await desk1.request({ t: 'desk.knock' }, 'knock.ok');
    const sid1 = knock1.sessionId as string;
    await assist.next('assist.knock', (m) => m.sessionId === sid1);
    await assist.request({ t: 'assist.accept', sessionId: sid1 }, 'session.created');
    await desk1.next('session.created');
    // The Desk process dies without a WS close frame: pause its socket so it stops answering pings
    // while TCP stays up, exactly as a crashed native agent looks until its heartbeat window lapses.
    desk1.ws.pause();
    // A new Desk process re-hellos with the same token at once. Before the fix this was `token_busy`
    // for ~10 s; now the dead incumbent is superseded and the fresh hello succeeds.
    const desk2 = await kit.deskOnline(compact);
    const knock2 = await desk2.request({ t: 'desk.knock' }, 'knock.ok');
    const sid2 = knock2.sessionId as string;
    expect(sid2).not.toBe(sid1);
    // The stale session is gone; a fresh knock reaches the Assist, which accepts it and consent runs.
    await assist.next('assist.knock', (m) => m.sessionId === sid2);
    await assist.request({ t: 'assist.accept', sessionId: sid2 }, 'session.created');
    await desk2.next('session.created');
    const open = await listOpenSessionsByToken(t.db, token.id);
    expect(open.map((s) => s.id)).toEqual([sid2]);
  });

  it('a live Desk is never superseded; the second hello stays token_busy', async () => {
    const admin = await signup(t.app);
    const { compact } = await createToken(t.app, admin);
    await kit.assistOnline(admin);
    const desk1 = await kit.deskOnline(compact);
    await desk1.request({ t: 'desk.knock' }, 'knock.ok'); // desk1 stays live and answers pings
    const desk2 = await kit.open();
    desk2.send({ t: 'desk.hello', token: compact, deskLabel: 'Second', id: 'h2' });
    const err = await desk2.next('error', (m) => m.re === 'h2');
    expect(err.code).toBe('token_busy');
    expect(await desk2.closed()).toBe(WS_CLOSE.tokenBusy);
    // desk1 keeps its live session.
    const poll = await desk1.request({ t: 'desk.poll' }, 'poll.status');
    expect(poll.sessionState).toBe('knocked');
  });
});
