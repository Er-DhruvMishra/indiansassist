import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, call, createToken, makeApp, signup, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;
let tech: Account;
let tech2: Account;
let senior: Account;
let auditor: Account;
let observer: Account;

beforeAll(async () => {
  t = await makeApp();
  admin = await signup(t.app);
  tech = await addMember(t.app, admin, 'technician');
  tech2 = await addMember(t.app, admin, 'technician');
  senior = await addMember(t.app, admin, 'senior_technician');
  auditor = await addMember(t.app, admin, 'auditor');
  observer = await addMember(t.app, admin, 'observer');
});
afterAll(async () => {
  await t.close();
});

const code = (res: { json: () => { error?: { code: string } } }) => res.json().error?.code;

describe('RBAC (section 2.3)', () => {
  it('users list: senior, admin, auditor yes; technician and observer forbidden', async () => {
    for (const a of [senior, admin, auditor]) expect((await call(t.app, '/api/v1/users', { cookie: a.cookie })).statusCode).toBe(200);
    for (const a of [tech, observer]) {
      const res = await call(t.app, '/api/v1/users', { cookie: a.cookie });
      expect(res.statusCode).toBe(403);
      expect(code(res)).toBe('forbidden');
    }
    const page = (await call(t.app, '/api/v1/users', { cookie: admin.cookie })).json();
    expect(page.items.length).toBe(6);
    expect(page.items[0].seat).not.toBeNull();
  });

  it('only org_admin may invite, change roles or patch branding', async () => {
    for (const a of [tech, senior, auditor, observer]) {
      expect((await call(t.app, '/api/v1/users/invite', { cookie: a.cookie, body: { email: 'x@example.test', name: 'X', role: 'technician' } })).statusCode).toBe(403);
      expect((await call(t.app, `/api/v1/users/${tech.user.id}/role`, { method: 'PATCH', cookie: a.cookie, body: { role: 'observer' } })).statusCode).toBe(403);
      expect((await call(t.app, '/api/v1/orgs/current/branding', { method: 'PATCH', cookie: a.cookie, body: { displayName: 'X' } })).statusCode).toBe(403);
    }
    const ok = await call(t.app, '/api/v1/orgs/current/branding', {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { displayName: 'Acme Support', accentColor: '#0f766e' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().branding).toEqual({ displayName: 'Acme Support', accentColor: '#0f766e' });
    const ext = await call(t.app, '/api/v1/orgs/current/branding', {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { logoData: 'https://cdn.example.com/logo.png' },
    });
    expect(ext.statusCode).toBe(400);
    const cleared = await call(t.app, '/api/v1/orgs/current/branding', { method: 'PATCH', cookie: admin.cookie, body: { accentColor: null } });
    expect(cleared.json().branding).toEqual({ displayName: 'Acme Support' });
  });

  it('auditors and observers cannot create tokens; observers cannot list them', async () => {
    for (const a of [auditor, observer])
      expect((await call(t.app, '/api/v1/tokens', { cookie: a.cookie, body: { tier: 'p1_browser', typ: 'one_time' } })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/tokens', { cookie: observer.cookie })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/tokens', { cookie: auditor.cookie })).statusCode).toBe(200);
  });

  it('technicians see and revoke only their own tokens; seniors and admins act org-wide', async () => {
    const mine = await createToken(t.app, tech);
    const theirs = await createToken(t.app, tech2);
    const list = (await call(t.app, '/api/v1/tokens', { cookie: tech.cookie })).json();
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([mine.token.id]);
    expect((await call(t.app, `/api/v1/tokens/${theirs.token.id}`, { cookie: tech.cookie })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/tokens/${theirs.token.id}/revoke`, { cookie: tech.cookie, method: 'POST' })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/tokens/${theirs.token.id}/revoke`, { cookie: auditor.cookie, method: 'POST' })).statusCode).toBe(403);
    const bySenior = await call(t.app, `/api/v1/tokens/${theirs.token.id}/revoke`, { cookie: senior.cookie, method: 'POST' });
    expect(bySenior.statusCode).toBe(200);
    expect(bySenior.json().status).toBe('revoked');
    const orgList = (await call(t.app, '/api/v1/tokens', { cookie: admin.cookie })).json();
    expect(orgList.items.length).toBeGreaterThanOrEqual(2);
  });

  it('cross-org objects are 404, never 403', async () => {
    const other = await signup(t.app);
    const tok = await createToken(t.app, other);
    const res = await call(t.app, `/api/v1/tokens/${tok.token.id}`, { cookie: admin.cookie });
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe('not_found');
    expect((await call(t.app, `/api/v1/users/${other.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'observer' } })).statusCode).toBe(404);
  });

  it('residency and audit export are for org_admin and auditor only', async () => {
    for (const a of [admin, auditor]) expect((await call(t.app, '/api/v1/orgs/current/residency', { cookie: a.cookie })).statusCode).toBe(200);
    for (const a of [tech, senior, observer]) {
      expect((await call(t.app, '/api/v1/orgs/current/residency', { cookie: a.cookie })).statusCode).toBe(403);
      expect((await call(t.app, '/api/v1/audit/export', { cookie: a.cookie, body: {} })).statusCode).toBe(403);
    }
    for (const a of [tech, observer]) expect((await call(t.app, '/api/v1/audit', { cookie: a.cookie })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/audit', { cookie: senior.cookie })).statusCode).toBe(200);
  });

  it('protects the last org_admin and moves seats with role changes', async () => {
    const demoteSelf = await call(t.app, `/api/v1/users/${admin.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'technician' } });
    expect(demoteSelf.statusCode).toBe(400);
    expect(code(demoteSelf)).toBe('last_org_admin');
    const disableSelf = await call(t.app, `/api/v1/users/${admin.user.id}/status`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'disabled' } });
    expect(code(disableSelf)).toBe('last_org_admin');
    const toAuditor = await call(t.app, `/api/v1/users/${tech2.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'auditor' } });
    expect(toAuditor.statusCode).toBe(200);
    expect(toAuditor.json().role).toBe('auditor');
    const users = (await call(t.app, '/api/v1/users', { cookie: admin.cookie })).json();
    expect(users.items.find((u: { id: string }) => u.id === tech2.user.id).seat).toBeNull();
    const overPlan = await call(t.app, `/api/v1/users/${tech2.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'technician', tier: 'p3_portable' } });
    expect(code(overPlan)).toBe('tier_not_licensed');
  });

  it('disabling a user revokes their sessions and tokens', async () => {
    const victim = await addMember(t.app, admin, 'technician');
    const tok = await createToken(t.app, victim);
    const res = await call(t.app, `/api/v1/users/${victim.user.id}/status`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'disabled' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
    expect((await call(t.app, '/api/v1/auth/me', { cookie: victim.cookie })).statusCode).toBe(401);
    const got = await call(t.app, `/api/v1/tokens/${tok.token.id}`, { cookie: admin.cookie });
    expect(got.json().status).toBe('revoked');
  });
});
