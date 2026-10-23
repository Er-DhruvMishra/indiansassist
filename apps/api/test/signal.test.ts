import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSession, listAuditBySession, listAuditByOrgPaginated } from '@indiansassist/db';
import { addMember, call, createToken, listen, makeApp, signup, SignalClient, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let url: string;
let admin: Account;
let tech: Account;
const clients: SignalClient[] = [];

async function open(cookie?: string): Promise<SignalClient> {
  const c = await SignalClient.open(url, cookie ? { cookie } : {});
  clients.push(c);
  return c;
}

async function assistOnline(acc: Account): Promise<SignalClient> {
  const a = await open(acc.cookie);
  const ok = await a.request({ t: 'assist.hello' }, 'assist.hello.ok');
  expect(ok.user).toMatchObject({ id: acc.user.id, role: acc.user.role });
  return a;
}

async function deskOnline(token: string, deskLabel = 'Rahul laptop'): Promise<SignalClient> {
  const d = await open();
  const ok = await d.request({ t: 'desk.hello', token, deskLabel }, 'desk.hello.ok');
  expect(ok.tokenId).toEqual(expect.any(String));
  return d;
}

beforeAll(async () => {
  t = await makeApp();
  url = await listen(t.app);
  admin = await signup(t.app);
  tech = await addMember(t.app, admin, 'technician', 'Asha K');
});
afterAll(async () => {
  for (const c of clients) c.close();
  await t.close();
});

describe('/signal happy path', () => {
  it('walks poll -> knock -> accept -> consent -> offer/answer relay -> end', async () => {
    const { compact, token } = await createToken(t.app, tech);
    const desk = await deskOnline(compact);

    const p1 = await desk.request({ t: 'desk.poll' }, 'poll.status');
    expect(p1).toMatchObject({ state: 'waiting', technicianOnline: false });

    const assist = await assistOnline(tech);
    const p2 = await desk.request({ t: 'desk.poll' }, 'poll.status');
    expect(p2).toMatchObject({ state: 'waiting', technicianOnline: true });

    const knockOk = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    const sessionId = knockOk.sessionId as string;
    expect(knockOk.resumeKey).toEqual(expect.any(String));
    const knock = await assist.next('assist.knock');
    expect(knock).toMatchObject({ sessionId, tokenId: token.id, deskLabel: 'Rahul laptop', canAct: true, tokenCreatedBy: { id: tech.user.id, name: 'Asha K' } });

    // Media before accept and consent is refused and nothing is relayed.
    desk.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 too-early' });
    const early = await desk.next('error');
    expect(early.code).toBe('consent_required');
    expect(await assist.quiet('webrtc.offer')).toBe(true);

    const created = await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    expect(created).toMatchObject({ sessionId, state: 'consent_pending', consentState: 'pending', polite: true, assist: { id: tech.user.id, name: 'Asha K' } });
    expect(Array.isArray(created.iceServers)).toBe(true);
    const deskCreated = await desk.next('session.created');
    expect(deskCreated).toMatchObject({ sessionId, polite: false, assist: { name: 'Asha K' } });
    expect(deskCreated.iceServers).toBeUndefined();

    const p3 = await desk.request({ t: 'desk.poll' }, 'poll.status');
    expect(p3).toMatchObject({ state: 'matched', sessionId, sessionState: 'consent_pending' });

    // Accepted but no consent yet: still no media relay (hard rule 1).
    desk.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 before-consent' });
    expect((await desk.next('error')).code).toBe('consent_required');
    assist.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 assist-before-consent' });
    expect((await assist.next('error')).code).toBe('consent_required');
    expect(await assist.quiet('webrtc.offer', 200)).toBe(true);
    expect(await desk.quiet('webrtc.offer', 50)).toBe(true);

    const consent = await desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'consent.ok');
    expect(consent).toMatchObject({ sessionId, state: 'active', consentState: 'granted' });
    const deskTurn = (consent.iceServers as { username?: string }[]).find((s) => s.username);
    expect(deskTurn?.username).toMatch(new RegExp(`^\\d+:desk:${sessionId}$`));
    expect(await assist.next('consent.changed')).toMatchObject({ sessionId, state: 'granted', surface: 'monitor' });

    desk.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 offer-sdp' });
    expect(await assist.next('webrtc.offer')).toMatchObject({ sessionId, sdp: 'v=0 offer-sdp' });
    assist.send({ t: 'webrtc.answer', sessionId, sdp: 'v=0 answer-sdp' });
    expect(await desk.next('webrtc.answer')).toMatchObject({ sessionId, sdp: 'v=0 answer-sdp' });
    desk.send({ t: 'webrtc.ice', sessionId, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0' } });
    expect((await assist.next('webrtc.ice')).candidate).toMatchObject({ sdpMid: '0' });

    // Chat relay overwrites `from` and is counted (chat.relayed before session.ended).
    const msgId = '11111111-2222-4333-8444-555555555555';
    desk.send({ t: 'chat.message', sessionId, msgId, from: 'assist', text: 'hi', ts: Date.now() });
    expect(await assist.next('chat.message')).toMatchObject({ msgId, from: 'desk', text: 'hi' });

    assist.send({ t: 'session.end', sessionId, note: 'fixed the printer' });
    const endedA = await assist.next('session.ended');
    const endedD = await desk.next('session.ended');
    for (const e of [endedA, endedD])
      expect(e).toMatchObject({ sessionId, endReason: 'assist_ended', reachedActive: true, surface: 'monitor', assist: { id: tech.user.id } });
    expect(endedD.hashChainTail).toMatch(/^[0-9a-f]{64}$/);
    expect(await desk.closed()).toBe(4410);

    const row = await getSession(t.db, sessionId);
    expect(row).toMatchObject({ state: 'ended', endReason: 'assist_ended', consentState: 'granted', assistUserId: tech.user.id });
    const actions = (await listAuditBySession(t.db, sessionId)).map((e) => e.action);
    expect(actions).toEqual([
      'session.knock',
      'session.accepted',
      'session.consent_granted',
      'session.started',
      'chat.relayed',
      'session.ended',
    ]);
    const entries = await listAuditBySession(t.db, sessionId);
    expect(entries.at(-1)?.hash).toBe(endedD.hashChainTail);
    expect(entries.at(-1)?.reason).toBe('fixed the printer');
    expect(entries[0]?.actorType).toBe('desk');
    expect(JSON.stringify(entries[0]?.data)).not.toContain('Rahul');
    // one_time token became used on the first active transition.
    const tok = await call(t.app, `/api/v1/tokens/${token.id}`, { cookie: tech.cookie });
    expect(tok.json().status).toBe('used');
    // REST view of the same session.
    const rest = await call(t.app, `/api/v1/sessions/${sessionId}`, { cookie: tech.cookie });
    expect(rest.json()).toMatchObject({ state: 'ended', path: 'unknown', deskLabel: 'Rahul laptop', assist: { name: 'Asha K' } });
    expect(rest.json().participants.map((p: { role: string }) => p.role).sort()).toEqual(['assist', 'desk']);
  });
});

describe('/signal authorisation and gates', () => {
  it('a third connection sending a message for a session it is not part of gets error forbidden', async () => {
    const { compact } = await createToken(t.app, tech);
    const assist = await assistOnline(tech);
    const desk = await deskOnline(compact);
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.next('session.created');
    await desk.request({ t: 'desk.consent', state: 'granted', surface: 'window' }, 'consent.ok');

    // Another technician of the same org (and even the org_admin) is not a participant.
    const intruder = await assistOnline(admin);
    intruder.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 injected' });
    expect((await intruder.next('error')).code).toBe('forbidden');
    intruder.send({ t: 'session.end', sessionId });
    expect((await intruder.next('error')).code).toBe('forbidden');
    // A second anonymous Desk on another token cannot reach it either.
    const other = await createToken(t.app, tech);
    const desk2 = await deskOnline(other.compact);
    desk2.send({ t: 'webrtc.answer', sessionId, sdp: 'v=0 injected' });
    expect((await desk2.next('error')).code).toBe('forbidden');
    expect(await assist.quiet('webrtc.offer')).toBe(true);
    expect(await desk.quiet('webrtc.answer', 50)).toBe(true);
    expect((await getSession(t.db, sessionId as string))?.state).toBe('active');
    const forbidden = await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'signal.forbidden' });
    // Coalesced per (user, session) (SEC-05): the two attempts of the intruder write one entry.
    const mine = forbidden.items.filter((e) => (e.data as { sessionId?: string }).sessionId === sessionId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.data).toMatchObject({ messageType: 'webrtc.offer', sessionId });

    desk.send({ t: 'session.end', sessionId });
    expect((await assist.next('session.ended')).endReason).toBe('desk_stopped');
  });

  it('rejects messages before hello, unknown types and Desk-only types from an Assist', async () => {
    const c = await open();
    c.send({ t: 'desk.knock' });
    expect((await c.next('error')).code).toBe('not_authenticated');
    c.send({ t: 'session.created' });
    expect((await c.next('error')).code).toBe('unknown_type');
    c.send({ t: 'ping', id: 'p1' });
    expect((await c.next('pong')).re).toBe('p1');
    const a = await assistOnline(tech);
    a.send({ t: 'desk.knock' });
    expect((await a.next('error')).code).toBe('forbidden');
    const anon = await open();
    anon.send({ t: 'assist.hello' });
    expect((await anon.next('error')).code).toBe('not_authenticated');
    expect(await anon.closed()).toBe(4401);
  });

  it('desk.hello with a bad token gets the section 3.5 error and close 4403; wrong origin is refused', async () => {
    const d = await open();
    d.send({ t: 'desk.hello', token: '123412341234' });
    expect((await d.next('error')).code).toBe('token_not_found');
    expect(await d.closed()).toBe(4403);
    await expect(SignalClient.open(url, { origin: 'https://evil.example' })).rejects.toThrow(/403/);
  });

  it('holds a knock while no technician is online and performs it on assist.hello', async () => {
    const solo = await addMember(t.app, admin, 'technician', 'Night Shift');
    const { compact } = await createToken(t.app, solo);
    // org_admin and senior sockets would be eligible too, so close any admin socket first.
    for (const c of clients) if (c !== undefined) c.close();
    await new Promise((r) => setTimeout(r, 100));
    const desk = await deskOnline(compact, 'Front desk');
    const held = await desk.request({ t: 'desk.knock' }, 'knock.held');
    expect(held.technicianOnline).toBe(false);
    expect((await desk.request({ t: 'desk.poll' }, 'poll.status')).state).toBe('held');
    const assist = await assistOnline(solo);
    const knockOk = await desk.next('knock.ok');
    const knock = await assist.next('assist.knock');
    expect(knock).toMatchObject({ sessionId: knockOk.sessionId, deskLabel: 'Front desk' });
    // Deny keeps the Desk socket open so it can knock again.
    assist.send({ t: 'assist.deny', sessionId: knockOk.sessionId, reason: 'not now' });
    const ended = await desk.next('session.ended');
    expect(ended).toMatchObject({ endReason: 'denied', reachedActive: false });
    expect(await desk.quiet('nothing', 100)).toBe(true);
    expect(desk.closeCode).toBeNull();
    const actions = (await listAuditBySession(t.db, knockOk.sessionId as string)).map((e) => e.action);
    expect(actions).toEqual(['session.knock', 'session.denied', 'session.ended']);
  });

  it('three consecutive denials auto-revoke the token and close the Desk 4403', async () => {
    const { compact, token } = await createToken(t.app, tech);
    const assist = await assistOnline(tech);
    const desk = await deskOnline(compact);
    for (let i = 0; i < 3; i++) {
      const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
      await assist.next('assist.knock', (m) => m.sessionId === sessionId);
      assist.send({ t: 'assist.deny', sessionId });
      expect((await desk.next('session.ended', (m) => m.sessionId === sessionId)).endReason).toBe('denied');
    }
    expect((await desk.next('error')).code).toBe('token_gone');
    expect(await desk.closed()).toBe(4403);
    const tok = (await call(t.app, `/api/v1/tokens/${token.id}`, { cookie: tech.cookie })).json();
    expect(tok.status).toBe('revoked');
    const revoked = await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'token.revoked' });
    expect(revoked.items[0]).toMatchObject({ actorType: 'system', data: { tokenId: token.id, reason: 'auto_denied' } });
  });

  it('Desk resume during an active share returns to consent_pending; Assist resume keeps the state', async () => {
    const { compact } = await createToken(t.app, tech, { tier: 'p1_browser', typ: 'timed' });
    const assist = await assistOnline(tech);
    const desk = await deskOnline(compact);
    const { sessionId, resumeKey } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.request({ t: 'desk.consent', state: 'granted' }, 'consent.ok');
    desk.close();
    await new Promise((r) => setTimeout(r, 100));

    // Without the resume key the token is busy.
    const busy = await open();
    busy.send({ t: 'desk.hello', token: compact });
    expect((await busy.next('error')).code).toBe('token_busy');
    expect(await busy.closed()).toBe(4409);

    const desk2 = await open();
    const hello = await desk2.request({ t: 'desk.hello', token: compact, resumeKey }, 'desk.hello.ok');
    expect(hello.resume).toMatchObject({ sessionId, state: 'consent_pending', consentState: 'pending' });
    expect((await desk2.next('session.created')).state).toBe('consent_pending');
    expect(await assist.next('desk.reconnected')).toMatchObject({ sessionId, state: 'consent_pending' });
    await desk2.request({ t: 'desk.consent', state: 'granted', surface: 'browser' }, 'consent.ok');

    const assist2 = await assistOnline(tech);
    const resumed = await assist2.request({ t: 'assist.resume', sessionId }, 'session.created');
    expect(resumed).toMatchObject({ sessionId, state: 'active', consentState: 'granted', polite: true });
    expect((await desk2.next('assist.reconnected')).state).toBe('active');
    // The old Assist socket is no longer the participant.
    assist.send({ t: 'webrtc.answer', sessionId, sdp: 'stale' });
    expect((await assist.next('error')).code).toBe('forbidden');
    // Another user cannot resume it.
    const other = await assistOnline(admin);
    other.send({ t: 'assist.resume', sessionId });
    expect((await other.next('error')).code).toBe('forbidden');

    await desk2.request({ t: 'desk.consent', state: 'revoked' }, 'consent.ok');
    expect((await assist2.next('session.ended')).endReason).toBe('consent_revoked');
    const actions = (await listAuditBySession(t.db, sessionId as string)).map((e) => e.action);
    expect(actions).toEqual([
      'session.knock',
      'session.accepted',
      'session.consent_granted',
      'session.started',
      'session.resumed',
      'session.consent_granted',
      'session.started',
      'session.resumed',
      'signal.forbidden',
      'signal.forbidden',
      'session.consent_revoked',
      'session.ended',
    ]);
  });

  it('REST end pushes session.ended and Desk events are attested', async () => {
    const { compact } = await createToken(t.app, tech);
    const assist = await assistOnline(tech);
    const desk = await deskOnline(compact);
    const { sessionId } = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.request({ t: 'desk.consent', state: 'granted' }, 'consent.ok');
    const sha = 'a'.repeat(64);
    const ev = await desk.request(
      { t: 'desk.event', sessionId, action: 'file.received', data: { fileId: 1, direction: 'assist_to_desk', name: 'report.pdf', bytes: 10, sha256: sha } },
      'event.ok',
    );
    expect(ev.entryId).toEqual(expect.any(String));
    const rest = await call(t.app, `/api/v1/sessions/${sessionId}/events`, {
      cookie: tech.cookie,
      body: { action: 'file.sent', data: { fileId: 1, direction: 'assist_to_desk', name: 'report.pdf', bytes: 10, sha256: sha } },
    });
    expect(rest.statusCode).toBe(201);
    const rec1 = await call(t.app, `/api/v1/sessions/${sessionId}/events`, { cookie: tech.cookie, body: { action: 'recording.started', data: {} } });
    expect(rec1.statusCode).toBe(201);
    expect((await desk.next('session.recording')).recording).toBe(true);
    const rec2 = await call(t.app, `/api/v1/sessions/${sessionId}/events`, { cookie: tech.cookie, body: { action: 'recording.started', data: {} } });
    expect(rec2.statusCode).toBe(200);
    expect(rec2.json().id).toBe(rec1.json().id);

    const end = await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: tech.cookie, body: { note: 'done' } });
    expect(end.statusCode).toBe(200);
    expect(end.json()).toMatchObject({ state: 'ended', endReason: 'assist_ended', recordingStarted: true });
    expect((await desk.next('session.ended')).recordingStarted).toBe(true);
    const again = await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: tech.cookie, body: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_ended');
    const audit = (await call(t.app, `/api/v1/sessions/${sessionId}/audit`, { cookie: tech.cookie })).json();
    expect(audit.integrity).toMatchObject({ ok: true });
    expect(audit.files).toEqual([
      { fileId: 1, direction: 'assist_to_desk', name: 'report.pdf', bytes: 10, assistSha256: sha, deskSha256: sha, match: true },
    ]);
  });
});
