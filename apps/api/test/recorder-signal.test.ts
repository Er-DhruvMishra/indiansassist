/**
 * Phase A.2 signaling (docs/specs/phase-a2-recorder.md sections 4-7): recorder auth, assignment after consent, join
 * rules, peer-tagged relay, pause on Desk resume, stop on leave / socket loss / session end, and the audit entries.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listAuditBySession } from '@indiansassist/db';
import { call, listen, makeApp, signup, SignalClient, type Account, type TestApp } from './helpers.js';
import { Kit } from './signal-kit.js';

const TOKEN = 'recorder-test-token-0123456789abcdef';
let t: TestApp;
let url: string;
let admin: Account;
let kit: Kit;
const kits: Kit[] = [];

function newKit(): Kit {
  kit = new Kit(t, url);
  kits.push(kit);
  return kit;
}

beforeAll(async () => {
  t = await makeApp({ RECORDER_TOKEN: TOKEN }, { recorderJoinTimeoutMs: 400 });
  url = await listen(t.app);
  admin = await signup(t.app);
  await setMode('server');
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  for (const k of kits.splice(0)) k.closeAll();
});

async function setMode(mode: string): Promise<void> {
  const res = await call(t.app, '/api/v1/orgs/current/policy/recording', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { recordingMode: mode },
  });
  expect(res.statusCode).toBe(200);
}

async function recorderOnline(id = 'rec-a'): Promise<SignalClient> {
  const r = await kit.open();
  const ok = await r.request(
    { t: 'recorder.hello', token: TOKEN, recorderId: id, version: '0.1.0', region: 'in-mum' },
    'recorder.hello.ok',
  );
  expect(ok.nodeId).toBe('test-node');
  return r;
}

async function actions(sessionId: string): Promise<string[]> {
  return (await listAuditBySession(t.db, sessionId)).map((e) => e.action);
}

/** An active session with a joined recorder. */
async function joined(reuse = false) {
  if (!reuse) newKit();
  const rec = await recorderOnline();
  const s = await kit.activeSession(admin);
  const assign = await rec.next('recorder.assign', (m) => m.sessionId === s.sessionId);
  expect(assign).toMatchObject({ recordingMode: 'server', resume: false, tier: 'p1_browser', region: 'in-mum' });
  await rec.request({ t: 'recorder.join', sessionId: s.sessionId }, 'recorder.joined');
  return { ...s, rec };
}

describe('recorder auth', () => {
  it('refuses a wrong token with forbidden + 4403 and accepts the service token', async () => {
    newKit();
    const bad = await kit.open();
    bad.send({ t: 'recorder.hello', token: 'nope', recorderId: 'rec-x', version: '1', region: 'in-mum' });
    expect((await bad.next('error')).code).toBe('forbidden');
    expect(await bad.closed()).toBe(4403);
    const r = await recorderOnline();
    r.send({ t: 'desk.knock' });
    expect((await r.next('error')).code).toBe('forbidden');
  });

  it('refuses recorder.hello when the recorder is disabled on the api', async () => {
    const t2 = await makeApp();
    try {
      const c = await SignalClient.open(await listen(t2.app));
      c.send({ t: 'recorder.hello', token: TOKEN, recorderId: 'rec-x', version: '1', region: 'in-mum' });
      expect(await c.closed()).toBe(4403);
    } finally {
      await t2.close();
    }
  });
});

describe('recorder session flow', () => {
  it('joins after consent, tells both sides, relays peer-tagged frames and stops with the session', async () => {
    const { assist, desk, sessionId, rec } = await joined();
    expect(await desk.next('session.recording', (m) => m.source === 'server')).toMatchObject({ recording: true });
    expect(await assist.next('session.recording', (m) => m.source === 'server')).toMatchObject({ recording: true });
    rec.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 recorder' });
    expect(await desk.next('webrtc.offer')).toMatchObject({ peer: 'recorder', sdp: 'v=0 recorder' });
    expect(await assist.quiet('webrtc.offer')).toBe(true);
    desk.send({ t: 'webrtc.answer', sessionId, sdp: 'v=0 answer', peer: 'recorder' });
    expect(await rec.next('webrtc.answer')).toMatchObject({ peer: 'recorder', sdp: 'v=0 answer' });
    desk.send({ t: 'webrtc.ice', sessionId, candidate: null, peer: 'recorder' });
    await rec.next('webrtc.ice');
    // The Assist cannot impersonate the recorder: `peer` is stripped.
    assist.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 assist', peer: 'recorder' });
    const fromAssist = await desk.next('webrtc.offer', (m) => m.sdp === 'v=0 assist');
    expect(fromAssist.peer).toBeUndefined();
    desk.send({ t: 'session.end', sessionId });
    const ended = await rec.next('session.ended');
    expect(ended).toMatchObject({ sessionId, serverRecording: true });
    const a = await actions(sessionId);
    const started = a.indexOf('recording.server_started');
    const stopped = a.indexOf('recording.server_stopped');
    expect(started).toBeGreaterThan(a.indexOf('session.started'));
    expect(stopped).toBeGreaterThan(started);
    expect(stopped).toBeLessThan(a.indexOf('session.ended'));
    const entries = await listAuditBySession(t.db, sessionId);
    expect(entries.find((e) => e.action === 'recording.server_stopped')!.data).toEqual({
      recorderId: 'rec-a',
      reason: 'session_ended',
    });
    const s = await call(t.app, `/api/v1/sessions/${sessionId}`, { cookie: admin.cookie });
    expect(s.json()).toMatchObject({ serverRecording: true, recordingMode: 'server' });
    expect((s.json() as { participants: { role: string }[] }).participants.map((p) => p.role)).toContain('recorder');
  });

  it('refuses a join without an assignment and recorder media before a join', async () => {
    newKit();
    const other = await recorderOnline('rec-b');
    const { sessionId, rec } = await joined(true);
    const j = await other.request({ t: 'recorder.join', sessionId }, 'error');
    expect(j.code).toBe('forbidden');
    other.send({ t: 'webrtc.offer', sessionId, sdp: 'x' });
    expect((await other.next('error')).code).toBe('forbidden');
    rec.send({ t: 'recorder.leave', sessionId, reason: 'track_ended' });
    await new Promise((r) => setTimeout(r, 200));
    const entries = await listAuditBySession(t.db, sessionId);
    expect(entries.find((e) => e.action === 'recording.server_stopped')!.data).toEqual({
      recorderId: 'rec-a',
      reason: 'track_ended',
    });
    rec.send({ t: 'webrtc.offer', sessionId, sdp: 'late' });
    expect((await rec.next('error')).code).toBe('forbidden');
  });

  it('writes recorder_left when the recorder socket drops and does not re-assign', async () => {
    const { desk, sessionId, rec } = await joined();
    await desk.next('session.recording', (m) => m.source === 'server' && m.recording === true);
    rec.close();
    expect(await desk.next('session.recording', (m) => m.source === 'server' && m.recording === false)).toBeTruthy();
    const entries = await listAuditBySession(t.db, sessionId);
    expect(entries.filter((e) => e.action === 'recording.server_stopped').map((e) => e.data)).toEqual([
      { recorderId: 'rec-a', reason: 'recorder_left' },
    ]);
    const r2 = await recorderOnline('rec-c');
    expect(await r2.quiet('recorder.assign', 300)).toBe(true);
  });

  it('pauses on a Desk resume and re-assigns the same recorder after re-consent', async () => {
    const { desk, sessionId, rec, compact, resumeKey } = await joined();
    desk.close();
    const d2 = await kit.open();
    await d2.request({ t: 'desk.hello', token: compact, resumeKey }, 'desk.hello.ok');
    expect(await rec.next('recorder.pause')).toMatchObject({ sessionId, reason: 'consent_pending' });
    await d2.next('session.created');
    await d2.request({ t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'consent.ok');
    expect(await rec.next('recorder.assign', (m) => m.sessionId === sessionId)).toMatchObject({ resume: true });
    expect(await rec.request({ t: 'recorder.join', sessionId }, 'recorder.joined')).toMatchObject({ resume: true });
    expect((await actions(sessionId)).filter((a) => a === 'recording.server_started')).toHaveLength(1);
  });

  it('re-assigns to another recorder when the first does not join in time', async () => {
    newKit();
    const r1 = await recorderOnline('rec-1');
    const s = await kit.activeSession(admin);
    await r1.next('recorder.assign', (m) => m.sessionId === s.sessionId);
    const r2 = await recorderOnline('rec-2');
    // r2 says hello after the assignment; the timeout moves it to r2.
    const second = await r2.next('recorder.assign', (m) => m.sessionId === s.sessionId, 3000);
    expect(second.resume).toBe(false);
    const late = await r1.request({ t: 'recorder.join', sessionId: s.sessionId }, 'error');
    expect(late.code).toBe('forbidden');
  });

  it('sends recordingMode in session.created and assigns nothing under assist_only', async () => {
    await setMode('assist_only');
    try {
      newKit();
      const rec = await recorderOnline();
      const s = await kit.activeSession(admin);
      await new Promise((r) => setTimeout(r, 300));
      expect(rec.messages.some((m) => m.t === 'recorder.assign' && m.sessionId === s.sessionId)).toBe(false);
      const row = await call(t.app, `/api/v1/sessions/${s.sessionId}`, { cookie: admin.cookie });
      expect(row.json()).toMatchObject({ recordingMode: 'assist_only', serverRecording: false });
    } finally {
      await setMode('server');
    }
  });
});
