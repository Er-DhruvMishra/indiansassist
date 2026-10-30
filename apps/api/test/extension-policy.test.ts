/** Phase B org extension policy (section 11.3), console event reports (3.7, Y24) and the Y21 origin rules. */
import { BUILTIN_DENY_LIST, DEFAULT_EXTENSION_POLICY, pepperedHash } from '@indiansassist/shared';
import { getOrg } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfOk } from '../src/plugins/security.js';
import { reportClock } from '../src/routes/session-events.js';
import { addMember, call, createToken, listen, makeApp, signup, type Account, type TestApp } from './helpers.js';
import { EXT_ORIGIN, licenceP2, OP, P2Kit, p2Token, patchPolicy, sessionAudit } from './p2-kit.js';

let t: TestApp;
let kit: P2Kit;
let admin: Account;

beforeAll(async () => {
  t = await makeApp({ EXTENSION_WEBSTORE_URL: 'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop' }, { tickMs: 50 });
  kit = new P2Kit(t, await listen(t.app));
  admin = await signup(t.app);
  await licenceP2(t, admin);
});
afterAll(async () => {
  kit.closeAll();
  await t.close();
});

describe('GET / PATCH /orgs/current/policy/extension', () => {
  it('any role reads the merged policy plus the built-in list; only org_admin patches', async () => {
    const observer = await addMember(t.app, admin, 'observer');
    const got = await call(t.app, '/api/v1/orgs/current/policy/extension', { cookie: observer.cookie });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ ...DEFAULT_EXTENSION_POLICY, builtinDenyList: [...BUILTIN_DENY_LIST] });
    const tech = await addMember(t.app, admin, 'technician');
    expect((await patchPolicy(t, tech, { allowAllTabs: false })).statusCode).toBe(403);
  });

  it('patches, resets with null, validates and audits org.policy_updated', async () => {
    const r = await patchPolicy(t, admin, { allowAllTabs: false, denyList: ['Bank.Example.com', '*.pay.test'], maskSelectors: ['.secret'] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ allowAllTabs: false, denyList: ['bank.example.com', '*.pay.test'], maskSelectors: ['.secret'] });
    expect(r.json().updatedAt).toMatch(/Z$/);
    expect((await patchPolicy(t, admin, { allowAllTabs: null })).json().allowAllTabs).toBe(true);
    for (const bad of [{ denyList: ['x.test:443'] }, { maxConsentLevel: 'view' }, { updatedAt: null }, { nope: 1 }])
      expect((await patchPolicy(t, admin, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    const audit = (await call(t.app, '/api/v1/audit?action=org.policy_updated', { cookie: admin.cookie })).json();
    expect(audit.items.map((e: { data: { fields: string[] } }) => [...e.data.fields].sort())).toEqual([['allowAllTabs'], ['allowAllTabs', 'denyList', 'maskSelectors']]);
  });

  it('is limited to 10 changes per minute per user', async () => {
    const limited = await makeApp({ RATE_LIMIT_DISABLED: 'false' });
    try {
      const a = await signup(limited.app);
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await patchPolicy(limited, a, { titlePrefix: i % 2 === 0 })).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('public lookup for P2 (2.1, 11.3, Y21)', () => {
  it('discloses joinSupported and the install info for p2 only', async () => {
    const p2 = await p2Token(t, admin);
    const r = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: p2.compact } });
    expect(r.json()).toMatchObject({
      tier: 'p2_extension',
      joinSupported: true,
      extension: { ids: [], webStoreUrl: 'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop', edgeAddonsUrl: null, minVersion: '0.2.0' },
    });
    const p1 = await createToken(t.app, admin);
    expect((await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: p1.compact } })).json().extension).toBeNull();
  });

  it('accepts an extension Origin with X-Requested-With on public-lookup only', async () => {
    const p2 = await p2Token(t, admin);
    const ok = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: p2.compact }, headers: { origin: EXT_ORIGIN } });
    expect(ok.statusCode).toBe(200);
    const noHeader = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: p2.compact }, headers: { origin: EXT_ORIGIN }, csrf: false });
    expect(noHeader.json().error.code).toBe('csrf_failed');
    const elsewhere = await call(t.app, '/api/v1/auth/login', { body: { email: 'x@y.test', password: 'x' }, headers: { origin: EXT_ORIGIN } });
    expect(elsewhere.json().error.code).toBe('csrf_failed');
    const listedOnly = (o: string) => o === EXT_ORIGIN;
    expect(csrfOk('POST', { 'x-requested-with': 'IndiansAssist', origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 'http://w', listedOnly)).toBe(false);
    expect(csrfOk('POST', { 'x-requested-with': 'IndiansAssist', origin: EXT_ORIGIN }, 'http://w', listedOnly)).toBe(true);
  });

  it('with EXTENSION_IDS set, only listed ids pass the WS upgrade', async () => {
    const strict = await makeApp({ EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop' });
    try {
      const url = await listen(strict.app);
      const { SignalClient } = await import('./helpers.js');
      const ok = await SignalClient.open(url, { origin: EXT_ORIGIN });
      ok.close();
      await expect(SignalClient.open(url, { origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })).rejects.toThrow(/403/);
      expect(strict.ctx.config.extension.ids).toEqual(['abcdefghijklmnopabcdefghijklmnop']);
    } finally {
      await strict.close();
    }
  });
});

describe('POST /sessions/:id/events console reports (3.7, Y24)', () => {
  it('writes the user half of each pair with hostHash and the typed reason', async () => {
    const s = await kit.active(admin);
    const post = (body: unknown) => call(t.app, `/api/v1/sessions/${s.sessionId}/events`, { cookie: admin.cookie, body });
    expect((await post({ action: 'tab.action', data: { kind: 'tabs.create', opId: OP, host: 'example.com' } })).statusCode).toBe(201);
    expect((await post({ action: 'level.requested', data: { level: 'in_page', opId: OP }, reason: 'click the print button' })).statusCode).toBe(201);
    expect((await post({ action: 'backstage.enter', data: { host: 'shop.example.com', opId: OP } })).statusCode).toBe(201);
    expect((await post({ action: 'control.input', data: { mode: 'dom', tabId: 1, count: 4, kinds: ['key'], windowMs: 10000 } })).statusCode).toBe(201);
    expect((await post({ action: 'tab.action', data: { kind: 'tabs.create', opId: OP, hostHash: 'a'.repeat(64) } })).statusCode).toBe(400);
    expect((await post({ action: 'tab.action', data: { kind: 'tabs.pin', opId: OP, tabId: 1 }, reason: 'x' })).statusCode).toBe(400);
    const org = (await getOrg(t.db, admin.org.id))!;
    const audit = await sessionAudit(t, admin, s.sessionId);
    const tab = audit.items.find((e) => e.action === 'tab.action')!;
    expect(tab.actor.type).toBe('user');
    expect(tab.data).toEqual({ kind: 'tabs.create', opId: OP, hostHash: pepperedHash(org.auditPepper, 'example.com') });
    expect(audit.items.find((e) => e.action === 'level.requested')?.reason).toBe('click the print button');
    expect(Object.values(audit.hosts).sort()).toEqual(['example.com', 'shop.example.com']);
  });

  it('refuses P1 sessions and sessions that never reached active', async () => {
    const p = await kit.pending(admin);
    const r = await call(t.app, `/api/v1/sessions/${p.sessionId}/events`, { cookie: admin.cookie, body: { action: 'level.requested', data: { level: 'view', opId: OP } } });
    expect(r.statusCode).toBe(403);
  });

  it('is limited to 10 / s burst 30 per session', async () => {
    const limited = await makeApp({ RATE_LIMIT_DISABLED: 'false' }, { tickMs: 50 });
    const k2 = new P2Kit(limited, await listen(limited.app));
    // The bucket's clock is held still, so how long the requests take on a loaded machine cannot refill it.
    let now = Date.now();
    reportClock.now = () => now;
    try {
      const a = await signup(limited.app);
      await licenceP2(limited, a);
      const s = await k2.active(a);
      const report = (i: number) =>
        call(limited.app, `/api/v1/sessions/${s.sessionId}/events`, { cookie: a.cookie, body: { action: 'tab.action', data: { kind: 'tabs.pin', opId: OP, tabId: i } } });
      const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => report(i)));
      expect(burst.filter((r) => r.statusCode === 201)).toHaveLength(30);
      const refused = burst.filter((r) => r.statusCode === 429);
      expect(refused).toHaveLength(10);
      expect(refused[0]!.json().error.code).toBe('rate_limited');
      expect(refused[0]!.headers['retry-after']).toBe('1');
      now += 500; // half a second refills 5 at 10 / s
      const refill = await Promise.all(Array.from({ length: 8 }, (_, i) => report(100 + i)));
      expect(refill.filter((r) => r.statusCode === 201)).toHaveLength(5);
      expect(refill.filter((r) => r.statusCode === 429)).toHaveLength(3);
    } finally {
      reportClock.now = () => Date.now();
      k2.closeAll();
      await limited.close();
    }
  });
});
