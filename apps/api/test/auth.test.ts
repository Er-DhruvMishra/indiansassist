import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditByOrgPaginated } from '@indiansassist/db';
import { call, cookieOf, makeApp, PASSWORD, signup, uniq, addMember, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

async function actions(orgId: string): Promise<string[]> {
  const page = await listAuditByOrgPaginated(t.db, orgId, { limit: 200 });
  return page.items.map((e) => e.action).reverse();
}

describe('auth', () => {
  it('signup creates org, org_admin and p1 seat, sets the session cookie and audits auth.signup', async () => {
    const email = `${uniq('s')}@example.test`;
    const res = await call(t.app, '/api/v1/auth/signup', {
      body: { orgName: 'Acme IT Services', name: 'Priya S', email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email, name: 'Priya S', role: 'org_admin', status: 'active' });
    expect(body.org).toMatchObject({ name: 'Acme IT Services', dataRegion: 'in-mum', planTier: 'p2_extension' });
    expect(body.org.slug).toMatch(/^acme-it-services/);
    expect(body.seat).toMatchObject({ tier: 'p1_browser', active: true, userId: body.user.id });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/ia_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=604800/);
    expect(setCookie).not.toMatch(/Secure/);
    expect(await actions(body.org.id)).toEqual(['auth.signup']);

    const me = await call(t.app, '/api/v1/auth/me', { cookie: cookieOf(res) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(body.user.id);
    expect(me.json().seat.tier).toBe('p1_browser');
  });

  it('rejects a duplicate email, an explicit duplicate slug and a bad body', async () => {
    const a = await signup(t.app, { slug: uniq('slug').toLowerCase() });
    const dupEmail = await call(t.app, '/api/v1/auth/signup', {
      body: { orgName: 'X', name: 'X', email: (await meEmail(a.cookie)).toUpperCase(), password: PASSWORD },
    });
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error.code).toBe('email_taken');
    const dupSlug = await call(t.app, '/api/v1/auth/signup', {
      body: { orgName: 'Y', slug: a.org.slug, name: 'Y', email: `${uniq()}@example.test`, password: PASSWORD },
    });
    expect(dupSlug.statusCode).toBe(409);
    expect(dupSlug.json().error.code).toBe('slug_taken');
    const bad = await call(t.app, '/api/v1/auth/signup', { body: { orgName: 'Z', name: 'Z', email: 'nope', password: 'short' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    expect(Array.isArray(bad.json().error.details.issues)).toBe(true);
  });

  it('login mints a fresh session; wrong password is 401 and audited as auth.login_failed', async () => {
    const a = await signup(t.app);
    const email = await meEmail(a.cookie);
    const wrong = await call(t.app, '/api/v1/auth/login', { body: { email, password: 'wrong password!' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    const unknown = await call(t.app, '/api/v1/auth/login', { body: { email: 'nobody@example.test', password: PASSWORD } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe('invalid_credentials');

    const ok = await call(t.app, '/api/v1/auth/login', { body: { email: email.toUpperCase(), password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const c2 = cookieOf(ok);
    expect(c2).not.toBe(a.cookie);
    expect(ok.json().user.lastLoginAt).not.toBeNull();
    expect(await actions(a.org.id)).toEqual(['auth.signup', 'auth.login_failed', 'auth.login']);
  });

  it('logout revokes the session: me then answers 401', async () => {
    const a = await signup(t.app);
    const out = await call(t.app, '/api/v1/auth/logout', { cookie: a.cookie, method: 'POST' });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/ia_session=;/);
    const me = await call(t.app, '/api/v1/auth/me', { cookie: a.cookie });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('unauthenticated');
    expect((await actions(a.org.id)).at(-1)).toBe('auth.logout');
  });

  it('me without a cookie, or with a forged cookie, is 401', async () => {
    expect((await call(t.app, '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: 'ia_session=forged.value' })).statusCode).toBe(401);
  });

  it('enforces the CSRF header and the Origin rule on state-changing requests', async () => {
    const body = { email: 'x@example.test', password: PASSWORD };
    const noHeader = await call(t.app, '/api/v1/auth/login', { body, csrf: false });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe('csrf_failed');
    const badOrigin = await call(t.app, '/api/v1/auth/login', { body, headers: { origin: 'https://evil.example' } });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json().error.code).toBe('csrf_failed');
    const goodOrigin = await call(t.app, '/api/v1/auth/login', { body, headers: { origin: 'http://localhost:5173' } });
    expect(goodOrigin.statusCode).toBe(401);
  });

  it('locks an email out after 10 failures in 15 minutes', async () => {
    const a = await signup(t.app);
    const email = await meEmail(a.cookie);
    for (let i = 0; i < 10; i++)
      expect((await call(t.app, '/api/v1/auth/login', { body: { email, password: 'wrong password!' } })).statusCode).toBe(401);
    const locked = await call(t.app, '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('rate_limited');
    expect(locked.json().error.details.retryAfterSec).toBeGreaterThan(0);
  });

  it('password change requires the current password and revokes other sessions', async () => {
    const a = await signup(t.app);
    const email = await meEmail(a.cookie);
    const other = cookieOf(await call(t.app, '/api/v1/auth/login', { body: { email, password: PASSWORD } }));
    const bad = await call(t.app, '/api/v1/auth/password', {
      cookie: a.cookie,
      body: { currentPassword: 'not it at all', newPassword: 'another long password' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('reauth_required');
    const ok = await call(t.app, '/api/v1/auth/password', {
      cookie: a.cookie,
      body: { currentPassword: PASSWORD, newPassword: 'another long password' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: a.cookie })).statusCode).toBe(200);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: other })).statusCode).toBe(401);
    const relogin = await call(t.app, '/api/v1/auth/login', { body: { email, password: 'another long password' } });
    expect(relogin.statusCode).toBe(200);
  });

  it('accept-invite is single use and logs in with method invite', async () => {
    const admin = await signup(t.app);
    const email = `${uniq('inv')}@example.test`;
    const inv = await call(t.app, '/api/v1/users/invite', {
      cookie: admin.cookie,
      body: { email, name: 'Rahul T', role: 'technician' },
    });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().inviteUrl).toMatch(/^http:\/\/localhost:5173\/invite#i=/);
    expect(inv.json().user.status).toBe('invited');
    const secret = inv.json().inviteUrl.split('#i=')[1];
    const pre = await call(t.app, '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(pre.statusCode).toBe(401);
    const acc = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite: secret, name: 'Rahul T', password: PASSWORD } });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().user.status).toBe('active');
    expect(acc.json().seat.tier).toBe('p1_browser');
    const again = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite: secret, name: 'Rahul T', password: PASSWORD } });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('invite_invalid');
    const page = await listAuditByOrgPaginated(t.db, admin.org.id, { limit: 50 });
    const login = page.items.find((e) => e.action === 'auth.login');
    expect(login?.data).toEqual({ method: 'invite' });
    const invited = page.items.find((e) => e.action === 'user.invited');
    expect(JSON.stringify(invited?.data)).not.toContain(email);
  });

  it('health and well-known are public', async () => {
    const h = await call(t.app, '/api/v1/health');
    expect(h.statusCode).toBe(200);
    expect(h.json()).toMatchObject({ ok: true, region: 'in-mum', servedRegions: [], nodeId: 'test-node' });
    const wk = await call(t.app, '/.well-known/indiansassist.json');
    expect(wk.statusCode).toBe(200);
    expect(wk.headers['cache-control']).toBe('public, max-age=300');
    expect(wk.json().keys[0]).toMatchObject({ alg: 'Ed25519', kid: t.ctx.keys.kid, pub: t.ctx.keys.pubB64 });
    expect(wk.json().signal).toBe('ws://localhost:4000/signal');
  });

  it('member helper works for every role', async () => {
    const admin = await signup(t.app);
    const obs = await addMember(t.app, admin, 'observer');
    const me = await call(t.app, '/api/v1/auth/me', { cookie: obs.cookie });
    expect(me.json().user.role).toBe('observer');
    expect(me.json().seat).toBeNull();
  });
});

async function meEmail(cookie: string): Promise<string> {
  const me = await call(t.app, '/api/v1/auth/me', { cookie });
  return (me.json() as { user: { email: string } }).user.email;
}
