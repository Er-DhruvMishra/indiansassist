/**
 * Phase C signaling (sections 3.1-3.8): Origin-less sockets (null principal, deskOnly, recorder allowed, assist
 * refused), the native tier gate and minimum version, `desk.consent.native`, the P3 level family, the clipboard /
 * monitor switches, relay refusal, `sec:` notes, idempotent `session.end`, native resume and the stats fold.
 */
import { getSession, listAuditBySession } from '@indiansassist/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { call, createToken, listen, SignalClient, type Account, type TestApp } from './helpers.js';
import { makeP3App, NATIVE, OP, P3Kit, p3Admin, p3Token } from './p3-kit.js';

const RTOKEN = 'recorder-test-token-0123456789abcdef';
let t: TestApp;
let url: string;
let admin: Account;
let kit: P3Kit;

beforeAll(async () => {
  t = await makeP3App({ RECORDER_TOKEN: RTOKEN });
  url = await listen(t.app);
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => kit?.closeAll());

const actions = async (sessionId: string) => (await listAuditBySession(t.db, sessionId)).map((e) => e.action);

describe('Origin-less sockets and the tier gate', () => {
  it('assist.hello on an Origin-less socket is forbidden even with a cookie; recorder.hello works', async () => {
    kit = new P3Kit(t, url);
    const s = await SignalClient.open(url, { origin: null, cookie: admin.cookie });
    kit.clients.push(s);
    const err = await s.request({ t: 'assist.hello' }, 'error');
    expect(err.code).toBe('forbidden');
    expect(await s.closed()).toBe(4403);
    const r = await kit.socket();
    const ok = await r.request({ t: 'recorder.hello', token: RTOKEN, recorderId: 'rec-x', version: '0.1.0', region: 'in-mum' }, 'recorder.hello.ok');
    expect(ok.nodeId).toBe('test-node');
  });

  it('p3 needs a native client; native on p1 and an old version are join_unsupported', async () => {
    kit = new P3Kit(t, url);
    const { compact } = await p3Token(t, admin, 'timed');
    const web = await SignalClient.open(url);
    kit.clients.push(web);
    const e1 = await web.request({ t: 'desk.hello', token: compact }, 'error');
    expect(e1).toMatchObject({ code: 'join_unsupported', details: { tier: 'p3_portable', expectedClient: 'native' } });
    const old = await kit.socket();
    const e2 = await old.request({ t: 'desk.hello', token: compact, client: { ...NATIVE, version: '0.2.9' } }, 'error');
    expect(e2).toMatchObject({ code: 'join_unsupported', details: { minVersion: '0.3.0' } });
    const p1 = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed', ttlMinutes: 30 });
    const n1 = await kit.socket();
    expect((await n1.request({ t: 'desk.hello', token: p1.compact, client: NATIVE }, 'error')).code).toBe('join_unsupported');
    const ok = await kit.nativeDesk(compact);
    expect(ok).toBeTruthy();
  });
});

describe('P3 consent', () => {
  it('session.created carries agent.playbooks; native consent validated and stored; consent.changed', async () => {
    kit = new P3Kit(t, url);
    const p = await kit.pending(admin);
    expect(Array.isArray((p.created.agent as { playbooks: unknown[] }).playbooks)).toBe(true);
    expect((p.created.agent as { playbooks: { name: string }[] }).playbooks.map((x) => x.name)).toContain('Flush DNS cache');
    expect(p.deskCreated.agent).toEqual(p.created.agent);
    const bad1 = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'error');
    expect(bad1.code).toBe('bad_payload');
    const bad2 = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'elevated', monitors: [1], clipboard: false } }, 'error');
    expect(bad2.code).toBe('bad_payload');
    const bad3 = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'window', native: { level: 'control', monitors: [1], clipboard: false } }, 'error');
    expect(bad3.code).toBe('bad_payload');
    const ok = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1, 2], clipboard: true } }, 'consent.ok');
    expect(ok.state).toBe('active');
    expect(await p.assist.next('consent.changed')).toMatchObject({ level: 'control', monitors: 2, clipboard: true, surface: 'monitor' });
    const s = (await getSession(t.db, p.sessionId))!;
    expect([s.consentLevel, s.consentMonitors, s.consentClipboard]).toEqual(['control', 2, true]);
    const entries = await listAuditBySession(t.db, p.sessionId);
    expect(entries.find((e) => e.action === 'session.consent_granted')?.data).toEqual({ surface: 'monitor', level: 'control', monitors: 2, clipboard: true });
  });

  it('a native consent on a P1 session is refused', async () => {
    kit = new P3Kit(t, url);
    const { compact } = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed', ttlMinutes: 30 });
    const assist = await kit.assist(admin);
    const d = await SignalClient.open(url);
    kit.clients.push(d);
    await d.request({ t: 'desk.hello', token: compact }, 'desk.hello.ok');
    const knock = await d.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === knock.sessionId);
    await assist.request({ t: 'assist.accept', sessionId: knock.sessionId }, 'session.created');
    await d.next('session.created');
    const err = await d.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'view', monitors: [1], clipboard: false } }, 'error');
    expect(err.code).toBe('bad_payload');
  });

  it('level family: view / control only, never elevated; clipboard and monitor switches are audited', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    const id = a.sessionId;
    expect((await a.desk.request({ t: 'desk.consent_level', sessionId: id, level: 'elevated' }, 'error')).code).toBe('bad_payload');
    expect((await a.desk.request({ t: 'desk.consent_level', sessionId: id, level: 'in_page' }, 'error')).code).toBe('bad_payload');
    const lv = await a.desk.request({ t: 'desk.consent_level', sessionId: id, level: 'view' }, 'consent.level_ok');
    expect(lv).toMatchObject({ level: 'view', backstage: false, clipboard: false });
    expect((await a.assist.next('consent.changed')).level).toBe('view');
    const up = await a.desk.request({ t: 'desk.consent_level', sessionId: id, level: 'control', requested: true, opId: OP }, 'consent.level_ok');
    expect(up.level).toBe('control');
    await a.assist.next('consent.changed');
    expect((await a.desk.request({ t: 'desk.consent_clipboard', sessionId: id, clipboard: true }, 'consent.level_ok')).clipboard).toBe(true);
    expect((await a.assist.next('consent.changed')).clipboard).toBe(true);
    await a.desk.request({ t: 'desk.consent_monitors', sessionId: id, monitors: [1] }, 'consent.level_ok');
    expect((await a.assist.next('consent.changed')).monitors).toBe(1);
    const acts = await actions(id);
    expect(acts.filter((x) => x === 'consent.level_changed')).toHaveLength(2);
    expect(acts).toContain('consent.clipboard_changed');
    expect(acts).toContain('consent.monitors_changed');
    const lc = (await listAuditBySession(t.db, id)).filter((e) => e.action === 'consent.level_changed').map((e) => e.data);
    expect(lc[1]).toEqual({ from: 'view', to: 'control', requestedBy: 'assist', opId: OP });
  });

  it('relay fallback is refused for p3; agent stats fold into lastStats', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    const err = await a.assist.request({ t: 'control.relay', sessionId: a.sessionId, msg: { t: 'ctl.req', id: 'x', op: 'tabs.list', args: {}, ts: 1 } }, 'error');
    expect(err.code).toBe('bad_state');
    a.assist.send({ t: 'session.stats', sessionId: a.sessionId, path: 'p2p', rttMs: 10, codec: 'VP8', bitrateKbps: 800, fps: 24, width: 1600, height: 900, packetsLost: 0, ts: Date.now(), encoder: 'vp8', capturePath: 'projection', floorMode: true, encodeMs: 6, glassMs: 90, monitorsStreaming: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const s = (await getSession(t.db, a.sessionId))!;
    expect(s.lastStats).toMatchObject({ encoder: 'vp8', capturePath: 'projection', floorMode: true, glassMs: 90 });
  });

  it('a native Desk resumes into active; a sec: note from the Assist ends with error; a second session.end is idempotent', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    a.desk.close();
    await a.desk.closed();
    const d2 = await kit.socket();
    const ok = await d2.request({ t: 'desk.hello', token: a.compact, resumeKey: a.resumeKey, client: NATIVE }, 'desk.hello.ok');
    expect(ok.resume).toMatchObject({ state: 'active', consentState: 'granted' });
    expect(((await d2.next('session.created')).agent as { playbooks: unknown[] }).playbooks.length).toBeGreaterThan(0);
    await d2.next('ice.refresh');
    expect((await a.assist.next('desk.reconnected')).state).toBe('active');
    a.assist.send({ t: 'session.end', sessionId: a.sessionId, note: 'sec:mac' });
    const ended = await a.assist.next('session.ended');
    expect(ended.endReason).toBe('error');
    const again = await a.assist.request({ t: 'session.end', sessionId: a.sessionId, note: 'sec:mac' }, 'session.ended');
    expect(again.endReason).toBe('error');
    const res = await call(t.app, `/api/v1/sessions/${a.sessionId}`, { cookie: admin.cookie });
    expect(res.json().deskClient.capabilities.interpreters).toEqual(['powershell', 'cmd']);
  });
});
