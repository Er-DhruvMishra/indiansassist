/**
 * Phase C section 3.8 reports and attestations (`POST events` P3 actions with the level gate and `control.refused`,
 * the native `desk.event` actions), plus the agent policy, the signed `.iaconfig` route and the residency counts.
 */
import { publicKeyEntry, verifyIaconfig } from '@indiansassist/shared';
import { listAuditBySession } from '@indiansassist/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addMember, call, createToken, listen, type Account, type TestApp } from './helpers.js';
import { licenceP3, makeP3App, OP, P3Kit, p3Admin, p3Token } from './p3-kit.js';

let t: TestApp;
let url: string;
let admin: Account;
let kit: P3Kit;

beforeAll(async () => {
  t = await makeP3App();
  url = await listen(t.app);
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => kit?.closeAll());

const post = (sessionId: string, body: Record<string, unknown>, acc = admin) => call(t.app, `/api/v1/sessions/${sessionId}/events`, { cookie: acc.cookie, body });
const OS_INPUT = { mode: 'os', monitorId: 2, count: 4, kinds: ['pointer', 'text'], windowMs: 10000, textChars: 3 };

describe('console reports in a P3 session', () => {
  it('accepted at control; refused above the level with control.refused; the clipboard switch gates clipboard.sync', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    expect((await post(a.sessionId, { action: 'control.input', data: OS_INPUT })).statusCode).toBe(201);
    expect((await post(a.sessionId, { action: 'input.text_burst', data: { chars: 300, windowMs: 10000, monitorId: 1 } })).statusCode).toBe(201);
    expect((await post(a.sessionId, { action: 'sec.verified', data: { sas: '123456', gen: 0 } })).statusCode).toBe(201);
    expect((await post(a.sessionId, { action: 'monitor.selected', data: { monitorIds: [1, 2], opId: OP } })).statusCode).toBe(201);
    const el = await post(a.sessionId, { action: 'elevation.requested', data: { opId: OP }, reason: 'install the printer driver' });
    expect(el.statusCode).toBe(201);
    expect(el.json().reason).toBe('install the printer driver');
    expect((await post(a.sessionId, { action: 'level.requested', data: { level: 'control', opId: OP }, reason: 'help' })).statusCode).toBe(201);
    expect((await post(a.sessionId, { action: 'level.requested', data: { level: 'in_page', opId: OP } })).statusCode).toBe(400);
    expect((await post(a.sessionId, { action: 'control.input', data: { mode: 'dom', tabId: 1, count: 1, kinds: ['key'], windowMs: 1 } })).statusCode).toBe(400);
    expect((await post(a.sessionId, { action: 'tab.action', data: { kind: 'tabs.activate', opId: OP, tabId: 1 } })).statusCode).toBe(400);
    const clip = await post(a.sessionId, { action: 'clipboard.sync', data: { toAssist: 1, toDesk: 0, bytes: 5, windowMs: 10000 } });
    expect(clip.statusCode).toBe(403);
    await a.desk.request({ t: 'desk.consent_level', sessionId: a.sessionId, level: 'view' }, 'consent.level_ok');
    const refused = await post(a.sessionId, { action: 'control.input', data: OS_INPUT });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.details).toEqual({ required: 'control', granted: 'view' });
    const entries = await listAuditBySession(t.db, a.sessionId);
    const ref = entries.filter((e) => e.action === 'control.refused').map((e) => e.data);
    expect(ref).toEqual([
      { action: 'clipboard.sync', required: 'control', granted: 'control', transport: 'attestation' },
      { action: 'control.input', required: 'control', granted: 'view', transport: 'attestation' },
    ]);
    expect(entries.find((e) => e.action === 'control.input')?.data).toEqual(OS_INPUT);
  });

  it('native desk.event actions; P2 levels and P3-only actions stay in their family', async () => {
    kit = new P3Kit(t, url);
    const a = await kit.active(admin);
    const ev = (action: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      a.desk.request({ t: 'desk.event', sessionId: a.sessionId, action, data, ...extra }, 'event.ok').catch(() => null);
    expect(await ev('control.input', { ...OS_INPUT, refused: 1 })).not.toBeNull();
    expect(await ev('a11y.state', { enabled: false })).not.toBeNull();
    expect(await ev('elevation.denied', { opId: OP, cause: 'uac_cancelled' }, { reason: 'printer' })).not.toBeNull();
    expect(await ev('sec.failed', { reason: 'mac', channel: 'ia.control' })).not.toBeNull();
    expect(await ev('consent.level_refused', { from: 'view', requested: 'control', opId: OP, timeout: false }, { reason: 'r' })).not.toBeNull();
    const err = await a.desk.request({ t: 'desk.event', sessionId: a.sessionId, action: 'consent.level_refused', data: { from: 'view', requested: 'in_page', opId: OP, timeout: false } }, 'error');
    expect(err.code).toBe('bad_payload');
    const err2 = await a.desk.request({ t: 'desk.event', sessionId: a.sessionId, action: 'mirror.stopped', data: { reason: 'paused', batches: 0, bytes: 0 } }, 'error');
    expect(err2.code).toBe('bad_payload');
    const entries = await listAuditBySession(t.db, a.sessionId);
    expect(entries.find((e) => e.action === 'elevation.denied')?.reason).toBe('printer');
    expect(entries.find((e) => e.action === 'control.input' && e.actorType === 'desk')?.data).toMatchObject({ monitorId: 2, refused: 1 });
  });
});

describe('agent policy, iaconfig, residency', () => {
  it('requireSasConfirm defaults to true; org_admin may PATCH it', async () => {
    const tech = await addMember(t.app, admin, 'technician');
    expect((await call(t.app, '/api/v1/orgs/current/policy/agent', { cookie: tech.cookie })).json()).toEqual({ requireSasConfirm: true });
    expect((await call(t.app, '/api/v1/orgs/current/policy/agent', { method: 'PATCH', cookie: tech.cookie, body: { requireSasConfirm: false } })).statusCode).toBe(403);
    const r = await call(t.app, '/api/v1/orgs/current/policy/agent', { method: 'PATCH', cookie: admin.cookie, body: { requireSasConfirm: false } });
    expect(r.json()).toEqual({ requireSasConfirm: false });
    await call(t.app, '/api/v1/orgs/current/policy/agent', { method: 'PATCH', cookie: admin.cookie, body: { requireSasConfirm: true } });
  });

  it('POST /tokens/:id/iaconfig: signed by the region key, p3 only, admin or the creator, audited', async () => {
    const tech = await addMember(t.app, admin, 'technician');
    await licenceP3(t, tech, admin);
    const mine = await p3Token(t, tech, 'timed');
    const r = await call(t.app, `/api/v1/tokens/${mine.token.id}/iaconfig`, { cookie: tech.cookie, body: { deskLabel: 'Rahul' } });
    expect(r.statusCode).toBe(200);
    const cfg = await verifyIaconfig(r.json().iaconfig, [publicKeyEntry(t.ctx.keys.pub)]);
    expect(cfg).toMatchObject({ region: 'in-mum', code: mine.compact, deskLabel: 'Rahul', apiOrigin: 'http://localhost:4000' });
    const theirs = await p3Token(t, admin, 'timed');
    expect((await call(t.app, `/api/v1/tokens/${theirs.token.id}/iaconfig`, { cookie: tech.cookie, body: {} })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/tokens/${theirs.token.id}/iaconfig`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
    const p1 = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'one_time' });
    expect((await call(t.app, `/api/v1/tokens/${p1.token.id}/iaconfig`, { cookie: admin.cookie, body: {} })).json().error.code).toBe('invalid_token_type');
    const audit = await call(t.app, '/api/v1/audit?action=token.iaconfig_issued&limit=10', { cookie: admin.cookie });
    expect(audit.json().items.length).toBeGreaterThanOrEqual(2);
  });

  it('residency reports the P3 activity of the last 30 days', async () => {
    const r = await call(t.app, '/api/v1/orgs/current/residency', { cookie: admin.cookie });
    const body = r.json();
    expect(body.agentSessions).toBeGreaterThanOrEqual(2);
    expect(typeof body.elevationGrants).toBe('number');
    expect(typeof body.playbookRuns).toBe('number');
  });
});
