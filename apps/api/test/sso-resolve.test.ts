/**
 * Phase E section 15.2: account resolution, linking and JIT provisioning (section 3.6), and the read-only test flow.
 * Driven through OIDC against the in-process fake IdP.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { org as orgTable, ssoIdentity, updateOrg } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, cookieOf, signup, type TestApp } from './helpers.js';
import {
  adminWithDomain,
  auditOf,
  makeSsoApp,
  oidcConfig,
  oidcLogin,
  oidcTestFlow,
  sessionCookieOf,
  startFakeOidc,
  verifyDomain,
  type FakeDns,
  type FakeOidc,
} from './sso-fakes.js';

let t: TestApp & { dns: FakeDns };
let fake: FakeOidc;

function err(res: { headers: Record<string, unknown> }): string | null {
  const l = String(res.headers['location'] ?? '');
  return l.includes('sso_error=') ? new URL(l).searchParams.get('sso_error') : null;
}

async function setup(opts: { verify?: boolean; jit?: Record<string, unknown> } = {}) {
  const domain = `r${randomBytes(4).toString('hex')}.test`;
  const admin = await adminWithDomain(t, domain);
  const cfg = oidcConfig(fake, opts.jit ? { jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [], ...opts.jit } } : {});
  const r = await call(t.app, '/api/v1/orgs/current/sso', { method: 'PUT', cookie: admin.cookie, body: { config: cfg, clientSecret: fake.clientSecret } });
  expect(r.statusCode, r.body).toBe(200);
  if (opts.verify !== false) await verifyDomain(t, admin, domain);
  return { admin, domain };
}

async function identities(userId: string) {
  return t.db.select().from(ssoIdentity).where(eq(ssoIdentity.userId, userId));
}

const sub = () => `sub-${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  t = await makeSsoApp();
  fake = await startFakeOidc();
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('rules 1 and 2: identity and linking', () => {
  it('links an invited user of the org on a verified domain, activates them, then resolves by identity', async () => {
    const { admin, domain } = await setup();
    const inv = await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email: `inv@${domain}`, name: 'Inv Ited', role: 'technician', tier: 'p1_browser' } });
    expect(inv.statusCode).toBe(201);
    const userId = inv.json().user.id as string;
    const s = sub();
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: s, email: `INV@${domain}`, email_verified: true });
    expect(err(r)).toBeNull();
    const me = await call(t.app, '/api/v1/auth/me', { cookie: sessionCookieOf(r)! });
    expect(me.json().user.id).toBe(userId);
    expect(me.json().user.status).toBe('active');
    expect(await identities(userId)).toHaveLength(1);
    const linked = await auditOf(t.app, admin.cookie, 'auth.sso_linked');
    expect(linked[0]?.data).toEqual({ userId, protocol: 'oidc' });
    // rule 1 next time, even with another email claim
    const again = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: s, email: `changed@${domain}`, email_verified: true });
    expect(err(again)).toBeNull();
    expect((await call(t.app, '/api/v1/auth/me', { cookie: sessionCookieOf(again)! })).json().user.id).toBe(userId);
  });

  it('does not link without a verified domain', async () => {
    const { admin, domain } = await setup({ verify: false });
    await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email: `nolink@${domain}`, name: 'No Link', role: 'technician' } });
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: sub(), email: `nolink@${domain}`, email_verified: true });
    expect(err(r)).toBe('domain_not_verified');
    const failed = await auditOf(t.app, admin.cookie, 'auth.sso_failed');
    expect(failed[0]?.data['cause']).toBe('domain_not_verified');
    expect(failed[0]?.data['emailHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a disabled user is refused (rule 1) and a disabled email match is linked but refused (rule 2)', async () => {
    const { admin, domain } = await setup();
    const inv = await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email: `dis@${domain}`, name: 'Dis Abled', role: 'technician' } });
    const userId = inv.json().user.id as string;
    await call(t.app, `/api/v1/users/${userId}/status`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'disabled' } });
    const s = sub();
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: s, email: `dis@${domain}`, email_verified: true });
    expect(err(r)).toBe('user_disabled');
    expect(await identities(userId)).toHaveLength(1);
    const r2 = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: s, email: `dis@${domain}`, email_verified: true });
    expect(err(r2)).toBe('user_disabled');
  });
});

describe('rule 3: region-wide email conflict', () => {
  it('an email that belongs to another org of this region is email_conflict', async () => {
    const { admin, domain } = await setup();
    const elsewhere = await signup(t.app, { email: `taken@${domain}` });
    expect(elsewhere.org.id).not.toBe(admin.org.id);
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: sub(), email: `taken@${domain}`, email_verified: true });
    expect(err(r)).toBe('email_conflict');
    expect((await auditOf(t.app, admin.cookie, 'auth.sso_failed'))[0]?.data['cause']).toBe('email_conflict');
  });
});

describe('rule 4: JIT', () => {
  it('provisions with the default role and seat tier, chained user.provisioned', async () => {
    const { admin, domain } = await setup();
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: sub(), email: `jit@${domain}`, email_verified: true, name: 'Jit User' });
    expect(err(r)).toBeNull();
    const me = (await call(t.app, '/api/v1/auth/me', { cookie: sessionCookieOf(r)! })).json();
    expect(me.user.role).toBe('technician');
    expect(me.seat.tier).toBe('p1_browser');
    expect(me.user.name).toBe('Jit User');
    const prov = await auditOf(t.app, admin.cookie, 'user.provisioned');
    expect(prov[0]?.data).toMatchObject({ userId: me.user.id, role: 'technician', tier: 'p1_browser', protocol: 'oidc' });
    expect(prov[0]?.data['emailHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('JIT off is jit_disabled; an unverified domain is domain_not_verified', async () => {
    const off = await setup({ jit: { enabled: false } });
    expect(err(await oidcLogin(t.app, fake, off.admin.org.slug, off.admin.org.id, { sub: sub(), email: `x@${off.domain}`, email_verified: true }))).toBe('jit_disabled');
    const unv = await setup({ verify: false });
    expect(err(await oidcLogin(t.app, fake, unv.admin.org.slug, unv.admin.org.id, { sub: sub(), email: `x@${unv.domain}`, email_verified: true }))).toBe(
      'domain_not_verified',
    );
  });

  it('maps groups to roles (first match wins, no seat for auditors) and never creates an org_admin', async () => {
    const { admin, domain } = await setup({
      jit: { groupRoles: [{ group: 'audit', role: 'auditor' }, { group: 'seniors', role: 'senior_technician' }] },
    });
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: sub(), email: `aud@${domain}`, email_verified: true, groups: ['x', 'audit', 'seniors'] });
    const me = (await call(t.app, '/api/v1/auth/me', { cookie: sessionCookieOf(r)! })).json();
    expect(me.user.role).toBe('auditor');
    expect(me.seat).toBeNull();
    const bad = await call(t.app, '/api/v1/orgs/current/sso', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { config: oidcConfig(fake, { jit: { enabled: true, defaultRole: 'org_admin', defaultSeatTier: 'p1_browser', groupRoles: [] } }) },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    const bad2 = await call(t.app, '/api/v1/orgs/current/sso', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { config: oidcConfig(fake, { jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [{ group: 'a', role: 'org_admin' }] } }) },
    });
    expect(bad2.statusCode).toBe(400);
  });

  it('a seat tier above the plan is refused at save; after a plan downgrade provisioning is seat_unavailable', async () => {
    const { admin, domain } = await setup({ jit: { defaultSeatTier: 'p3_portable' } });
    const over = await call(t.app, '/api/v1/orgs/current/sso', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { config: oidcConfig(fake, { jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p4_installed', groupRoles: [] } }) },
    });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe('tier_not_licensed');
    await updateOrg(t.db, admin.org.id, { planTier: 'p1_browser' });
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: sub(), email: `seat@${domain}`, email_verified: true });
    expect(err(r)).toBe('seat_unavailable');
  });
});

describe('the test flow', () => {
  it('writes no identity and reports matchedSelf for rule 2, then for rule 1', async () => {
    const { admin } = await setup();
    const adminId = admin.user.id;
    const s = sub();
    const r = await oidcTestFlow(t.app, fake, admin, { sub: s, email: admin.email, email_verified: true });
    expect(r.statusCode).toBe(303);
    expect(String(r.headers['location'])).toBe('http://localhost:5173/app/settings/sso?test=ok');
    expect(sessionCookieOf(r)).toBeNull();
    expect(await identities(adminId)).toHaveLength(0);
    let settings = (await call(t.app, '/api/v1/orgs/current/sso', { cookie: admin.cookie })).json();
    expect(settings.lastTest).toMatchObject({ ok: true, cause: null, matchedSelf: true });
    expect((await auditOf(t.app, admin.cookie, 'sso.tested'))[0]?.data).toEqual({ protocol: 'oidc', ok: true, cause: null });
    // a real login links the admin (rule 2); the next test finds them by identity (rule 1)
    const login = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: s, email: admin.email, email_verified: true });
    expect(err(login)).toBeNull();
    expect(await identities(adminId)).toHaveLength(1);
    const r1 = await oidcTestFlow(t.app, fake, admin, { sub: s, email: `other@example.test`, email_verified: true });
    expect(String(r1.headers['location'])).toMatch(/test=ok$/);
    settings = (await call(t.app, '/api/v1/orgs/current/sso', { cookie: admin.cookie })).json();
    expect(settings.lastTest.matchedSelf).toBe(true);
    // somebody else's IdP account: ok, but not the acting admin
    const r2 = await oidcTestFlow(t.app, fake, admin, { sub: sub(), email: 'nobody@nowhere.test', email_verified: true });
    expect(String(r2.headers['location'])).toMatch(/test=ok$/);
    settings = (await call(t.app, '/api/v1/orgs/current/sso', { cookie: admin.cookie })).json();
    expect(settings.lastTest.matchedSelf).toBe(false);
  });

  it('a test ticket is single use and bound to the admin who asked for it; 409 bad_state without a config', async () => {
    const { admin } = await setup();
    const tt = await call(t.app, '/api/v1/orgs/current/sso/test', { cookie: admin.cookie, method: 'POST' });
    const beginUrl = tt.json().beginUrl as string;
    const stranger = await call(t.app, beginUrl, { headers: { 'sec-fetch-site': 'none' } });
    expect(String(stranger.headers['location'])).toMatch(/test=flow_expired$/);
    const reuse = await call(t.app, beginUrl, { cookie: admin.cookie, headers: { 'sec-fetch-site': 'none' } });
    expect(String(reuse.headers['location'])).toMatch(/test=flow_expired$/);
    const plain = await signup(t.app);
    const none = await call(t.app, '/api/v1/orgs/current/sso/test', { cookie: plain.cookie, method: 'POST' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('bad_state');
  });

  it('session lifetime follows sessionMaxAgeHours and the login is chained with its method', async () => {
    const { admin, domain } = await setup();
    const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: sub(), email: `life@${domain}`, email_verified: true });
    const line = ([] as string[]).concat(r.headers['set-cookie'] as string[]).find((c) => c.startsWith('ia_session='))!;
    expect(line).toMatch(/Max-Age=43200/);
    const logins = await auditOf(t.app, admin.cookie, 'auth.login');
    expect(logins[0]?.data).toEqual({ method: 'oidc' });
    expect(cookieOf(r)).toBeTruthy();
    const [o] = await t.db.select().from(orgTable).where(eq(orgTable.id, admin.org.id));
    expect(o?.ssoRequired).toBe(false);
  });
});


