/**
 * Phase C section 7.2: hand-over mint (audit, row fields, one outstanding, 3 per 10 min), the binding order of checks
 * of the elevated instance's hello on a one_time token (atomic consume, entry / client / state rejections, a
 * duplicate racing rejoin), the fresh resume key, `session.handed_over` + 4411, the sweeper's `handover_expired`,
 * and the recorder pause / re-assign.
 */
import { sha256Hex } from '@indiansassist/shared';
import { getSession, listAuditBySession, updateSession } from '@indiansassist/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, type Account, type TestApp } from './helpers.js';
import { ADMIN_CLIENT, makeP3App, NATIVE, OP, P3Kit, p3Admin, p3Token } from './p3-kit.js';
import { Sweeper } from '../src/sweeper.js';

const RTOKEN = 'recorder-test-token-0123456789abcdef';
let t: TestApp;
let url: string;
let admin: Account;
let kit: P3Kit;

beforeAll(async () => {
  t = await makeP3App({ RECORDER_TOKEN: RTOKEN }, { recorderJoinTimeoutMs: 2000 });
  url = await listen(t.app);
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => kit?.closeAll());

const actions = async (sessionId: string) => (await listAuditBySession(t.db, sessionId)).map((e) => e.action);
const failures = async (sessionId: string) =>
  (await listAuditBySession(t.db, sessionId)).filter((e) => e.action === 'elevation.failed').map((e) => e.data);

async function mint(a: Awaited<ReturnType<P3Kit['active']>>, opId = OP): Promise<string> {
  const ho = await a.desk.request({ t: 'desk.elevation', sessionId: a.sessionId, opId }, 'elevation.handover');
  return ho.handover as string;
}

async function adminHello(token: string, handover: string, client: Record<string, unknown> = ADMIN_CLIENT) {
  const d = await kit.socket();
  const reply = await d.request({ t: 'desk.hello', token, handover, client }, 'desk.hello.ok').catch(() => null);
  return { d, reply };
}

describe('hand-over mint', () => {
  it('needs control; chains handover_minted; one outstanding; at most 3 per 10 minutes', async () => {
    kit = new P3Kit(t, url);
    const v = await kit.active(admin, { level: 'view', monitors: [1], clipboard: false });
    expect((await v.desk.request({ t: 'desk.elevation', sessionId: v.sessionId, opId: OP }, 'error')).code).toBe('bad_state');
    const a = await kit.active(admin);
    const h1 = await mint(a);
    const s1 = (await getSession(t.db, a.sessionId))!;
    expect(s1.handoverHash).toBe(sha256Hex(h1));
    expect(s1.handoverOpid).toBe(OP);
    expect(s1.handoverExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await mint(a, 'abcdefabcdefabcd');
    expect(await t.ctx.presence.getKey(`ia:ho:${sha256Hex(h1)}`)).toBeNull();
    await mint(a, 'abcdefabcdefabce');
    expect((await a.desk.request({ t: 'desk.elevation', sessionId: a.sessionId, opId: OP }, 'error')).code).toBe('rate_limited');
    expect((await actions(a.sessionId)).filter((x) => x === 'elevation.handover_minted')).toHaveLength(3);
    // The superseded value is refused (its store key is gone and the row names the newest one).
    const { d, reply } = await adminHello(a.compact, h1);
    expect(reply).toBeNull();
    expect(await d.closed()).toBe(4403);
  });
});

describe('hand-over hello', () => {
  it('replaces the Desk on a one_time token: fresh resumeKey, 4411, elevated level, audits, replay refused', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    const h = await mint(a);
    const d2 = await kit.socket();
    const ok = await d2.request({ t: 'desk.hello', token: a.compact, handover: h, client: ADMIN_CLIENT }, 'desk.hello.ok');
    expect(typeof ok.resumeKey).toBe('string');
    expect(ok.resume).toEqual({ sessionId: a.sessionId, state: 'active', consentState: 'granted' });
    expect((await d2.next('session.created')).state).toBe('active');
    await d2.next('ice.refresh');
    expect((await a.desk.next('session.handed_over')).sessionId).toBe(a.sessionId);
    expect(await a.desk.closed()).toBe(4411);
    expect((await a.assist.next('desk.reconnected')).state).toBe('active');
    expect((await a.assist.next('consent.changed')).level).toBe('elevated');
    const s = (await getSession(t.db, a.sessionId))!;
    expect([s.elevation, s.consentLevel, s.handoverHash, s.handoverOpid]).toEqual(['admin', 'elevated', null, null]);
    expect(s.resumeKeyHash).toBe(sha256Hex(ok.resumeKey as string));
    const entries = await listAuditBySession(t.db, a.sessionId);
    expect(entries.find((e) => e.action === 'elevation.granted')?.data).toEqual({ opId: OP, elevation: 'admin', claimed: true });
    expect(entries.filter((e) => e.action === 'consent.level_changed').at(-1)?.data).toEqual({ from: 'control', to: 'elevated', requestedBy: 'assist', opId: OP });
    // The old instance's resume key is dead; the replayed hand-over is refused.
    const old = await kit.socket();
    const e1 = await old.request({ t: 'desk.hello', token: a.compact, resumeKey: a.resumeKey, client: NATIVE }, 'error');
    expect(e1.code).toBe('token_gone');
    const { d: replay, reply } = await adminHello(a.compact, h);
    expect(reply).toBeNull();
    expect(await replay.closed()).toBe(4403);
    // The fresh key resumes the elevated instance.
    d2.close();
    await d2.closed();
    const d3 = await kit.socket();
    const r = await d3.request({ t: 'desk.hello', token: a.compact, resumeKey: ok.resumeKey, client: ADMIN_CLIENT }, 'desk.hello.ok');
    expect(r.resume).toMatchObject({ state: 'active' });
  });

  it('rejects a client that is not admin, of another arch, an entry of another region, and an expired entry', async () => {
    kit = new P3Kit(t, url);
    const cases: [string, (h: string, sid: string) => Promise<Record<string, unknown>>][] = [
      ['not admin', async () => NATIVE],
      ['other arch', async () => ({ ...ADMIN_CLIENT, platform: { osVersion: '10.0.26100', arch: 'arm64' } })],
      [
        'other region',
        async (h) => {
          const key = `ia:ho:${sha256Hex(h)}`;
          const e = JSON.parse((await t.ctx.presence.getKey(key))!);
          await t.ctx.presence.setKey(key, JSON.stringify({ ...e, region: 'eu-fra' }), 120);
          return ADMIN_CLIENT;
        },
      ],
      [
        'expired',
        async (h) => {
          const key = `ia:ho:${sha256Hex(h)}`;
          const e = JSON.parse((await t.ctx.presence.getKey(key))!);
          await t.ctx.presence.setKey(key, JSON.stringify({ ...e, expiresAt: Date.now() - 1 }), 120);
          return ADMIN_CLIENT;
        },
      ],
    ];
    for (const [name, prep] of cases) {
      const a = await kit.active(admin);
      const h = await mint(a);
      const client = await prep(h, a.sessionId);
      const { d, reply } = await adminHello(a.compact, h, client);
      expect(reply, name).toBeNull();
      expect(await d.closed(), name).toBe(4403);
      expect(await failures(a.sessionId), name).toEqual([{ opId: OP, error: 'handover_rejected' }]);
      expect((await getSession(t.db, a.sessionId))!.handoverHash, name).toBeNull();
    }
  });

  it('two racing hellos with one hand-over: exactly one wins (atomic consume)', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    const h = await mint(a);
    const [x, y] = await Promise.all([adminHello(a.compact, h), adminHello(a.compact, h)]);
    expect([x.reply, y.reply].filter((r) => r !== null)).toHaveLength(1);
  });

  it('desk.elevation without the elevation feature is bad_state', async () => {
    kit = new P3Kit(t, url);
    const { compact } = await p3Token(t, admin, 'timed');
    const assist = await kit.assist(admin);
    const d = await kit.socket();
    const noElev = { ...NATIVE, capabilities: { ...NATIVE.capabilities, features: ['screen', 'input'] } };
    await d.request({ t: 'desk.hello', token: compact, client: noElev }, 'desk.hello.ok');
    const knock = await d.request({ t: 'desk.knock' }, 'knock.ok');
    await assist.next('assist.knock', (m) => m.sessionId === knock.sessionId);
    await assist.request({ t: 'assist.accept', sessionId: knock.sessionId }, 'session.created');
    await d.next('session.created');
    await d.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1], clipboard: false } }, 'consent.ok');
    expect((await d.request({ t: 'desk.elevation', sessionId: knock.sessionId, opId: OP }, 'error')).code).toBe('bad_state');
  });
});

describe('sweeper and recorder', () => {
  it('an unused hand-over past its expiry is chained handover_expired and cleared', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    const h = await mint(a);
    await updateSession(t.db, a.sessionId, { handoverExpiresAt: new Date(Date.now() - 1000) });
    await new Sweeper(t.ctx).expiredHandovers();
    expect(await failures(a.sessionId)).toEqual([{ opId: OP, error: 'handover_expired' }]);
    expect((await getSession(t.db, a.sessionId))!.handoverHash).toBeNull();
    expect(await t.ctx.presence.getKey(`ia:ho:${sha256Hex(h)}`)).toBeNull();
  });

  it('a recorder is assigned to a p3 session and is paused / re-assigned across the hand-over', async () => {
    kit = new P3Kit(t, url);
    const res = await call(t.app, '/api/v1/orgs/current/policy/recording', { method: 'PATCH', cookie: admin.cookie, body: { recordingMode: 'server' } });
    expect(res.statusCode).toBe(200);
    const rec = await kit.socket();
    await rec.request({ t: 'recorder.hello', token: RTOKEN, recorderId: 'rec-p3', version: '0.1.0', region: 'in-mum' }, 'recorder.hello.ok');
    const a = await kit.active(admin);
    const assign = await rec.next('recorder.assign', (m) => m.sessionId === a.sessionId);
    expect(assign.tier).toBe('p3_portable');
    await rec.request({ t: 'recorder.join', sessionId: a.sessionId }, 'recorder.joined');
    const h = await mint(a);
    await adminHello(a.compact, h);
    expect((await rec.next('recorder.pause', (m) => m.sessionId === a.sessionId)).reason).toBe('consent_pending');
    expect((await rec.next('recorder.assign', (m) => m.sessionId === a.sessionId)).resume).toBe(true);
    await call(t.app, '/api/v1/orgs/current/policy/recording', { method: 'PATCH', cookie: admin.cookie, body: { recordingMode: 'assist_only' } });
  });
});
