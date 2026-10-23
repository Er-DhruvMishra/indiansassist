/** Phase B signaling (sections 2.4, 3.1, 3.2, 3.5, 3.6, 6 B1, Y21): extension Desk, P2 consent, levels, resume. */
import { pepperedHash } from '@indiansassist/shared';
import { getOrg, listSessionHosts } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createToken, listen, makeApp, signup, SignalClient, type TestApp } from './helpers.js';
import { EXT_CLIENT, EXT_ORIGIN, licenceP2, OP, P2Kit, p2Token, patchPolicy, sessionAudit } from './p2-kit.js';

let t: TestApp;
let kit: P2Kit;
let url: string;

beforeAll(async () => {
  t = await makeApp({}, { tickMs: 50 });
  url = await listen(t.app);
  kit = new P2Kit(t, url);
});
afterAll(async () => {
  kit.closeAll();
  await t.close();
});

async function p2Admin() {
  const admin = await signup(t.app);
  await licenceP2(t, admin);
  return admin;
}

describe('desk.hello tier gate (2.4)', () => {
  it('p2 needs the extension client, p1 a web client', async () => {
    const admin = await p2Admin();
    const p2 = await p2Token(t, admin);
    const web = await SignalClient.open(url);
    const err = await web.request({ t: 'desk.hello', token: p2.compact }, 'error');
    expect(err).toMatchObject({ code: 'join_unsupported', details: { tier: 'p2_extension', expectedClient: 'extension' } });
    expect(await web.closed()).toBe(4403);
    const p1 = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed' });
    const ext = await SignalClient.open(url, { origin: EXT_ORIGIN });
    const err2 = await ext.request({ t: 'desk.hello', token: p1.compact, client: EXT_CLIENT }, 'error');
    expect(err2).toMatchObject({ code: 'join_unsupported', details: { tier: 'p1_browser', expectedClient: 'web' } });
    const ok = await kit.extDesk(p2.compact);
    expect(ok.closeCode).toBeNull();
  });

  it('an extension origin may not say assist.hello; unknown origins are refused (dev: any extension id)', async () => {
    const admin = await p2Admin();
    const ext = await SignalClient.open(url, { origin: EXT_ORIGIN, cookie: admin.cookie });
    const err = await ext.request({ t: 'assist.hello' }, 'error');
    expect(err.code).toBe('forbidden');
    expect(await ext.closed()).toBe(4403);
    await expect(SignalClient.open(url, { origin: 'https://evil.test' })).rejects.toThrow(/403/);
    await expect(SignalClient.open(url, { origin: 'chrome-extension://not-an-id' })).rejects.toThrow(/403/);
  });

  it('session.created carries the extension policy on both copies and the session row the client', async () => {
    const admin = await p2Admin();
    const p = await kit.pending(admin);
    expect((p.created.extension as { policy: { allowAllTabs: boolean } }).policy.allowAllTabs).toBe(true);
    expect(p.deskCreated.extension).toEqual(p.created.extension);
    expect(p.deskCreated.iceServers).toBeUndefined();
    const s = (await call(t.app, `/api/v1/sessions/${p.sessionId}`, { cookie: admin.cookie })).json();
    expect(s).toMatchObject({ tier: 'p2_extension', deskClient: EXT_CLIENT, consentLevel: null });
  });
});

describe('desk.consent with extension (3.1)', () => {
  it('is required for p2 and rejected for p1', async () => {
    const admin = await p2Admin();
    const p = await kit.pending(admin);
    expect((await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'browser' }, 'error')).code).toBe('bad_payload');
    const p1 = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed' });
    const a = p.assist;
    const d = await SignalClient.open(url);
    kit.clients.push(d);
    await d.request({ t: 'desk.hello', token: p1.compact }, 'desk.hello.ok');
    const k = await d.request({ t: 'desk.knock' }, 'knock.ok');
    await a.next('assist.knock', (m) => m.sessionId === k.sessionId);
    await a.request({ t: 'assist.accept', sessionId: k.sessionId }, 'session.created');
    await d.next('session.created');
    const ext = { level: 'view', scope: 'current_tab', backstage: false };
    expect((await d.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', extension: ext }, 'error')).code).toBe('bad_payload');
  });

  it('is capped by the policy (allowDeepControl, allowAllTabs, backstageAllowed)', async () => {
    const admin = await p2Admin();
    expect((await patchPolicy(t, admin, { allowDeepControl: false, allowAllTabs: false, backstageAllowed: false })).statusCode).toBe(200);
    const p = await kit.pending(admin);
    const grant = (extension: Record<string, unknown>) => p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'browser', extension }, 'error');
    expect((await grant({ level: 'deep_control', scope: 'current_tab', backstage: false })).code).toBe('bad_payload');
    expect((await grant({ level: 'in_page', scope: 'all_tabs', backstage: false })).code).toBe('bad_payload');
    expect((await grant({ level: 'in_page', scope: 'current_tab', backstage: true })).code).toBe('bad_payload');
    const ok = await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'browser', extension: { level: 'in_page', scope: 'current_tab', backstage: false } }, 'consent.ok');
    expect(ok.state).toBe('active');
    const changed = await p.assist.next('consent.changed');
    expect(changed).toMatchObject({ state: 'granted', surface: 'browser', level: 'in_page', scope: 'current_tab', backstage: false });
    const audit = await sessionAudit(t, admin, p.sessionId);
    expect(audit.items.find((e) => e.action === 'session.consent_granted')?.data).toEqual({ surface: 'browser', level: 'in_page', scope: 'current_tab', backstage: false });
  });
});

describe('level and backstage changes (3.2, B1)', () => {
  it('desk.consent_level writes consent.level_changed and pushes consent.changed', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    const ok = await s.desk.request({ t: 'desk.consent_level', sessionId: s.sessionId, level: 'in_page', requested: true, opId: OP }, 'consent.level_ok');
    expect(ok).toMatchObject({ level: 'in_page', backstage: false });
    expect(await s.assist.next('consent.changed')).toMatchObject({ level: 'in_page', scope: 'current_tab', backstage: false });
    await s.desk.request({ t: 'desk.consent_level', sessionId: s.sessionId, level: 'view' }, 'consent.level_ok');
    const back = await s.desk.request({ t: 'desk.consent_backstage', sessionId: s.sessionId, backstage: true }, 'consent.level_ok');
    expect(back).toMatchObject({ level: 'view', backstage: true });
    const audit = await sessionAudit(t, admin, s.sessionId);
    const changes = audit.items.filter((e) => e.action === 'consent.level_changed').map((e) => e.data);
    expect(changes).toEqual([
      { from: 'tab_control', to: 'in_page', requestedBy: 'assist', opId: OP },
      { from: 'in_page', to: 'view', requestedBy: 'desk' },
    ]);
    expect(audit.items.find((e) => e.action === 'consent.backstage_changed')?.data).toEqual({ from: false, to: true });
    const row = (await call(t.app, `/api/v1/sessions/${s.sessionId}`, { cookie: admin.cookie })).json();
    expect(row).toMatchObject({ consentLevel: 'view', consentScope: 'current_tab', consentBackstage: true });
  });

  it('refuses levels above the cap, before active, and from the Assist', async () => {
    const admin = await p2Admin();
    await patchPolicy(t, admin, { maxConsentLevel: 'in_page', defaultConsentLevel: 'view' });
    const p = await kit.pending(admin);
    expect((await p.desk.request({ t: 'desk.consent_level', sessionId: p.sessionId, level: 'view' }, 'error')).code).toBe('bad_state');
    await p.desk.request({ t: 'desk.consent', state: 'granted', surface: 'browser', extension: { level: 'view', scope: 'current_tab', backstage: false } }, 'consent.ok');
    expect((await p.desk.request({ t: 'desk.consent_level', sessionId: p.sessionId, level: 'deep_control' }, 'error')).code).toBe('bad_payload');
    expect((await p.assist.request({ t: 'desk.consent_level', sessionId: p.sessionId, level: 'view' }, 'error')).code).toBe('forbidden');
  });
});

describe('desk.event P2 actions (3.6)', () => {
  it('tab.action { host } is chained as hostHash with a session_host row', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    const ok = await s.desk.request(
      { t: 'desk.event', sessionId: s.sessionId, action: 'tab.action', data: { kind: 'tabs.navigate', opId: OP, tabId: 4, host: 'example.com', ok: true } },
      'event.ok',
    );
    expect(ok.entryId).toBeTruthy();
    const org = (await getOrg(t.db, admin.org.id))!;
    const hash = pepperedHash(org.auditPepper, 'example.com');
    const audit = await sessionAudit(t, admin, s.sessionId);
    const entry = audit.items.find((e) => e.action === 'tab.action')!;
    expect(entry.actor.type).toBe('desk');
    expect(entry.data).toEqual({ kind: 'tabs.navigate', opId: OP, tabId: 4, hostHash: hash, ok: true });
    expect(entry.data).not.toHaveProperty('host');
    expect(audit.hosts).toEqual({ [hash]: 'example.com' });
    expect((await listSessionHosts(t.db, s.sessionId)).map((h) => h.host)).toEqual(['example.com']);
    expect(audit.integrity.ok).toBe(true);
  });

  it('reason only where allowed; every other new action is written', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    const send = (action: string, data: Record<string, unknown>, reason?: string) =>
      s.desk.request({ t: 'desk.event', sessionId: s.sessionId, action, data, ...(reason ? { reason } : {}) }, 'event.ok');
    await send('mirror.started', { reason: 'consent', scope: 'current_tab', level: 'tab_control', tabCount: 1, tabId: 4 });
    await send('mask.refused', { tabId: 4, scope: 'field', nodeId: 9, opId: OP, cause: 'refused' }, 'need the order id');
    await send('control.input', { mode: 'dom', tabId: 4, count: 2, kinds: ['pointer'], windowMs: 10000, refused: 0 });
    await send('backstage.enter', { tabId: 7, host: 'shop.example.com', opId: OP, ok: true });
    await send('mirror.stopped', { reason: 'ended', batches: 3, bytes: 900 });
    const bad = await s.desk.request({ t: 'desk.event', sessionId: s.sessionId, action: 'mirror.stopped', data: { reason: 'ended', batches: 1, bytes: 1 }, reason: 'x' }, 'error');
    expect(bad.code).toBe('bad_payload');
    const audit = await sessionAudit(t, admin, s.sessionId);
    expect(audit.items.find((e) => e.action === 'mask.refused')?.reason).toBe('need the order id');
    expect(Object.values(audit.hosts)).toContain('shop.example.com');
  });
});

describe('extension resume keeps active (3.5)', () => {
  it('re-sends session.created, then ice.refresh; the Assist sees desk.reconnected active', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    s.desk.close();
    await s.desk.closed();
    const d2 = await SignalClient.open(url, { origin: EXT_ORIGIN });
    kit.clients.push(d2);
    const ok = await d2.request({ t: 'desk.hello', token: s.compact, resumeKey: s.resumeKey, client: EXT_CLIENT }, 'desk.hello.ok');
    expect(ok.resume).toMatchObject({ sessionId: s.sessionId, state: 'active', consentState: 'granted' });
    const created = await d2.next('session.created');
    expect(created).toMatchObject({ state: 'active' });
    expect(created.extension).toBeTruthy();
    expect((await d2.next('ice.refresh')).iceServers).toBeTruthy();
    expect(await s.assist.next('desk.reconnected')).toMatchObject({ state: 'active', consentState: 'granted' });
    const audit = await sessionAudit(t, admin, s.sessionId);
    expect(audit.items.find((e) => e.action === 'session.resumed')?.data).toEqual({ side: 'desk', fromState: 'active', toState: 'active' });
    expect(await d2.quiet('error', 100)).toBe(true);
  });
});
