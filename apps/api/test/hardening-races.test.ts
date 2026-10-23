/**
 * Regression tests: Desk attestations (SEC-04), signal.forbidden / path_changed flood limits (SEC-05), consent
 * revocation state gate (prd-F6) and the signaling races (correctness-F2, F3, F4, F8, F9).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSession, listAuditByOrgPaginated, listAuditBySession, listOpenSessionsByToken } from '@indiansassist/db';
import { createToken, listen, makeApp, signup, type TestApp } from './helpers.js';
import { Kit, patchNextTransaction, sleep } from './signal-kit.js';

let t: TestApp;
let kit: Kit;

beforeAll(async () => {
  t = await makeApp({}, { graceMs: 400, tickMs: 50 });
  kit = new Kit(t, await listen(t.app));
});
afterAll(async () => {
  kit.closeAll();
  await t.close();
});

const attest = (sessionId: string, fileId: number) => ({
  t: 'desk.event',
  sessionId,
  action: 'file.received',
  data: { fileId, direction: 'assist_to_desk', name: 'x.bin', bytes: 1, sha256: '0'.repeat(64) },
});

describe('SEC-04 desk.event', () => {
  it('is refused before the session reached active and written once per transfer afterwards', async () => {
    const admin = await signup(t.app);
    const { compact } = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed' });
    const assist = await kit.assistOnline(admin);
    const desk = await kit.deskOnline(compact);
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock');
    desk.send(attest(sessionId as string, 1));
    expect((await desk.next('error')).code).toBe('consent_required');
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.request({ t: 'desk.consent', state: 'granted' }, 'consent.ok');
    desk.send(attest(sessionId as string, 10_001));
    expect((await desk.next('error')).code).toBe('bad_payload');
    const a = await desk.request(attest(sessionId as string, 2), 'event.ok');
    const b = await desk.request(attest(sessionId as string, 2), 'event.ok');
    expect(b.entryId).toBe(a.entryId);
    const files = (await listAuditBySession(t.db, sessionId as string)).filter((e) => e.action === 'file.received');
    expect(files).toHaveLength(1);
  });
});

describe('SEC-05 flood limits', () => {
  it('coalesces signal.forbidden per connection and session and closes a flooding socket 4403', async () => {
    const admin = await signup(t.app);
    const { sessionId } = await kit.activeSession(admin);
    const intruder = await kit.assistOnline(admin);
    for (let i = 0; i < 25; i++) intruder.send({ t: 'webrtc.ice', sessionId, candidate: null });
    expect(await intruder.closed()).toBe(4403);
    const rows = await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'signal.forbidden' });
    expect(rows.items).toHaveLength(1);
  });

  it('writes session.path_changed at most once per 30 s', async () => {
    const admin = await signup(t.app);
    const { assist, sessionId } = await kit.activeSession(admin);
    const stats = (path: string) => ({ t: 'session.stats', sessionId, path, rttMs: 10, codec: 'VP8', bitrateKbps: 900, fps: 30, width: 1280, height: 720, packetsLost: 0, ts: Date.now() });
    for (const path of ['p2p', 'relay', 'p2p', 'relay']) {
      t.ctx.hub.live.get(sessionId)!.lastStatsAt = 0; // skip the 4 s frame spacing
      assist.send(stats(path));
      await sleep(80);
    }
    const changes = (await listAuditBySession(t.db, sessionId)).filter((e) => e.action === 'session.path_changed');
    expect(changes).toHaveLength(1);
    expect((await getSession(t.db, sessionId))?.lastStats).toMatchObject({ path: 'relay' });
  });
});

describe('prd-F6 consent revocation gate', () => {
  it('desk.consent revoked before consent was asked is bad_state and changes nothing', async () => {
    const admin = await signup(t.app);
    const { compact } = await createToken(t.app, admin);
    const assist = await kit.assistOnline(admin);
    const desk = await kit.deskOnline(compact);
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock');
    desk.send({ t: 'desk.consent', state: 'revoked' });
    expect((await desk.next('error')).code).toBe('bad_state');
    expect((await getSession(t.db, sessionId as string))?.state).toBe('knocked');
    expect(desk.closeCode).toBeNull();
  });
});

describe('signaling races', () => {
  it('F2: two Desks knocking at once on one token create one session', async () => {
    const admin = await signup(t.app);
    const { compact, token } = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed' });
    await kit.assistOnline(admin);
    const d1 = await kit.deskOnline(compact);
    const d2 = await kit.deskOnline(compact);
    d1.send({ t: 'desk.knock' });
    d2.send({ t: 'desk.knock' });
    await sleep(400);
    expect(await listOpenSessionsByToken(t.db, token.id)).toHaveLength(1);
    const oks = [...d1.messages, ...d2.messages].filter((m) => m.t === 'knock.ok');
    const busy = [...d1.messages, ...d2.messages].filter((m) => m.t === 'error' && m.code === 'token_busy');
    expect(oks).toHaveLength(1);
    expect(busy).toHaveLength(1);
  });

  it('F3: frames received before the Desk closed are still handled (desk_stopped, not desk_left)', async () => {
    const admin = await signup(t.app);
    const { assist, desk, sessionId } = await kit.activeSession(admin);
    // Keep the attestation's transaction in flight so the close arrives while session.end is still queued.
    patchNextTransaction(t, { delayMs: 300 });
    desk.send(attest(sessionId, 3));
    desk.send({ t: 'session.end', sessionId });
    desk.close();
    const ended = await assist.next('session.ended', (m) => m.sessionId === sessionId);
    expect(ended.endReason).toBe('desk_stopped');
  });

  it('F4: two Assist hellos at once perform a held knock once and never send the Desk token_busy', async () => {
    const admin = await signup(t.app);
    const { compact } = await createToken(t.app, admin);
    const desk = await kit.deskOnline(compact);
    await desk.request({ t: 'desk.knock' }, 'knock.held');
    const a1 = await kit.open(admin.cookie);
    const a2 = await kit.open(admin.cookie);
    a1.send({ t: 'assist.hello' });
    a2.send({ t: 'assist.hello' });
    await desk.next('knock.ok');
    await sleep(300);
    expect(desk.messages.filter((m) => m.t === 'knock.ok' || m.t === 'error')).toEqual([]);
    expect(desk.closeCode).toBeNull();
  });

  it('F8: a resume whose transaction fails answers and closes the socket, and the grace still ends the session', async () => {
    const admin = await signup(t.app);
    const { assist, desk, sessionId, resumeKey, compact } = await kit.activeSession(admin);
    desk.close();
    await sleep(100);
    const d2 = await kit.open();
    patchNextTransaction(t, { throwError: new Error('connection reset') });
    d2.send({ t: 'desk.hello', token: compact, resumeKey });
    expect((await d2.next('error')).code).toBe('session_not_found');
    expect(await d2.closed()).toBe(4403);
    const ended = await assist.next('session.ended', (m) => m.sessionId === sessionId, 3000);
    expect(ended.endReason).toBe('desk_left');
  });

  it('F9: a grace timer that fires while a resume is in flight does not end the resumed session', async () => {
    const admin = await signup(t.app);
    const { desk, sessionId, resumeKey, compact } = await kit.activeSession(admin);
    desk.close();
    await sleep(250);
    const d2 = await kit.open();
    patchNextTransaction(t, { delayMs: 350 });
    const hello = await d2.request({ t: 'desk.hello', token: compact, resumeKey }, 'desk.hello.ok');
    expect(hello.resume).toMatchObject({ sessionId, state: 'consent_pending' });
    await sleep(500);
    expect((await getSession(t.db, sessionId))?.state).toBe('consent_pending');
    expect(d2.closeCode).toBeNull();
  });
});
