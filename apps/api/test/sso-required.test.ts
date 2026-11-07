/**
 * Phase E section 15.2: SSO required and break-glass (section 3.7): the five readiness conditions, the warning and
 * the dry run, the refusals of password login / invite / password change, the session cut-over, the break-glass
 * login (1 h, chained, mailed) and the last-break-glass protections.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { authSession, getOrg, user as userTable } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { notifyBreakGlassLogin } from '../src/sso/break-glass.js';
import { call, cookieOf, PASSWORD, type Account, type TestApp } from './helpers.js';
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

async function inviteAndAccept(admin: Account, email: string, role: string): Promise<{ id: string; cookie: string }> {
  const inv = await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email, name: `${role} user`, role } });
  expect(inv.statusCode, inv.body).toBe(201);
  const invite = new URL(inv.json().inviteUrl as string).hash.replace('#i=', '');
  const acc = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite, name: `${role} user`, password: PASSWORD } });
  expect(acc.statusCode, acc.body).toBe(200);
  return { id: inv.json().user.id as string, cookie: cookieOf(acc) };
}

async function patchRequired(a: Account, body: Record<string, unknown>) {
  return call(t.app, '/api/v1/orgs/current/sso/required', { method: 'PATCH', cookie: a.cookie, body });
}

async function configured() {
  const domain = `q${randomBytes(4).toString('hex')}.test`;
  const admin = await adminWithDomain(t, domain);
  const r = await call(t.app, '/api/v1/orgs/current/sso', { method: 'PUT', cookie: admin.cookie, body: { config: oidcConfig(fake), clientSecret: fake.clientSecret } });
  expect(r.statusCode, r.body).toBe(200);
  await verifyDomain(t, admin, domain);
  return { admin, domain };
}

beforeAll(async () => {
  t = await makeSsoApp();
  fake = await startFakeOidc();
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('readiness (rule 3.7a)', () => {
  it('reports each missing condition, including break_glass_password, then the warning and a dry run', async () => {
    const domain = `ready${randomBytes(4).toString('hex')}.test`;
    const admin = await adminWithDomain(t, domain);
    let r = await patchRequired(admin, { required: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('sso_not_ready');
    expect(r.json().error.details.missing).toEqual(['sso_enabled', 'verified_domain', 'break_glass', 'recent_test']);
    await call(t.app, '/api/v1/orgs/current/sso', { method: 'PUT', cookie: admin.cookie, body: { config: oidcConfig(fake), clientSecret: fake.clientSecret } });
    await verifyDomain(t, admin, domain);
    r = await patchRequired(admin, { required: true });
    expect(r.json().error.details.missing).toEqual(['break_glass', 'recent_test']);
    expect((await call(t.app, '/api/v1/orgs/current/sso/break-glass', { method: 'PUT', cookie: admin.cookie, body: { userIds: [admin.user.id] } })).statusCode).toBe(200);
    expect((await auditOf(t.app, admin.cookie, 'sso.break_glass_changed'))[0]?.data).toEqual({ userIds: [admin.user.id] });
    // a break-glass account without a password could not sign in
    const [row] = await t.db.select().from(userTable).where(eq(userTable.id, admin.user.id));
    await t.db.update(userTable).set({ passwordHash: null }).where(eq(userTable.id, admin.user.id));
    r = await patchRequired(admin, { required: true });
    expect(r.json().error.details.missing).toEqual(['break_glass_password', 'recent_test']);
    await t.db.update(userTable).set({ passwordHash: row!.passwordHash }).where(eq(userTable.id, admin.user.id));
    // a test login that matched someone else does not count
    await oidcTestFlow(t.app, fake, admin, { sub: 'other', email: 'nobody@else.test', email_verified: true });
    r = await patchRequired(admin, { required: true });
    expect(r.json().error.details.missing).toEqual(['recent_test']);
    await oidcTestFlow(t.app, fake, admin, { sub: 'me', email: admin.email, email_verified: true });
    // one active user outside the verified domain, with no identity
    await inviteAndAccept(admin, `outside${randomBytes(2).toString('hex')}@elsewhere.test`, 'technician');
    const dry = await patchRequired(admin, { required: true, dryRun: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().warnings).toEqual({ usersOutsideVerifiedDomains: 1 });
    expect(dry.json().required).toBe(false);
    expect(await auditOf(t.app, admin.cookie, 'sso.required_changed')).toHaveLength(0);
  });

  it('break-glass users must be active org_admins with a password, at most two', async () => {
    const { admin, domain } = await configured();
    // a JIT user promoted to org_admin has no password
    const jit = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: 'jit-bg', email: `jitbg@${domain}`, email_verified: true });
    const jitId = (await call(t.app, '/api/v1/auth/me', { cookie: sessionCookieOf(jit)! })).json().user.id as string;
    await call(t.app, `/api/v1/users/${jitId}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'org_admin' } });
    const r = await call(t.app, '/api/v1/orgs/current/sso/break-glass', { method: 'PUT', cookie: admin.cookie, body: { userIds: [jitId] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('break_glass_invalid_user');
    const tech = await inviteAndAccept(admin, `t${randomBytes(2).toString('hex')}@${domain}`, 'technician');
    const r2 = await call(t.app, '/api/v1/orgs/current/sso/break-glass', { method: 'PUT', cookie: admin.cookie, body: { userIds: [tech.id] } });
    expect(r2.json().error.code).toBe('break_glass_invalid_user');
    const ids = [admin.user.id, jitId, tech.id];
    const r3 = await call(t.app, '/api/v1/orgs/current/sso/break-glass', { method: 'PUT', cookie: admin.cookie, body: { userIds: ids } });
    expect(r3.statusCode).toBe(400);
    expect(r3.json().error.code).toBe('break_glass_invalid_user');
  });
});

describe('SSO required on', () => {
  let admin: Account & { email: string };
  let domain: string;
  let tech: { id: string; cookie: string };
  let secondAdmin: { id: string; cookie: string };
  let thirdAdmin: { id: string; cookie: string };
  let ssoCookie: string;
  let techEmail: string;
  const closed: string[][] = [];

  beforeAll(async () => {
    ({ admin, domain } = await configured());
    techEmail = `tech${randomBytes(2).toString('hex')}@${domain}`;
    tech = await inviteAndAccept(admin, techEmail, 'technician');
    secondAdmin = await inviteAndAccept(admin, `adm2${randomBytes(2).toString('hex')}@${domain}`, 'org_admin');
    thirdAdmin = await inviteAndAccept(admin, `adm3${randomBytes(2).toString('hex')}@${domain}`, 'org_admin');
    const sso = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: 'sso-user', email: `ssouser@${domain}`, email_verified: true });
    ssoCookie = sessionCookieOf(sso)!;
    expect((await call(t.app, '/api/v1/orgs/current/sso/break-glass', { method: 'PUT', cookie: admin.cookie, body: { userIds: [admin.user.id, secondAdmin.id] } })).statusCode).toBe(200);
    await oidcTestFlow(t.app, fake, admin, { sub: 'admin-sub', email: admin.email, email_verified: true });
    vi.spyOn(t.ctx.hub, 'closeSocketsForAuthSessions').mockImplementation((ids: readonly string[]) => {
      closed.push([...ids]);
    });
    const r = await patchRequired(admin, { required: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().required).toBe(true);
  });

  it('revokes password and invite sessions of non-break-glass users, closes their sockets, cuts break-glass sessions to 1 h', async () => {
    expect((await call(t.app, '/api/v1/auth/me', { cookie: tech.cookie })).statusCode).toBe(401);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: thirdAdmin.cookie })).statusCode).toBe(401);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: ssoCookie })).statusCode).toBe(200);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: admin.cookie })).statusCode).toBe(200);
    const changed = (await auditOf(t.app, admin.cookie, 'sso.required_changed'))[0]?.data;
    expect(changed?.['required']).toBe(true);
    expect(Number(changed?.['revokedSessions'])).toBeGreaterThanOrEqual(2);
    expect(closed.flat().length).toBe(changed?.['revokedSessions']);
    const rows = await t.db.select().from(authSession).where(eq(authSession.userId, admin.user.id));
    const live = rows.filter((s) => !s.revokedAt);
    expect(live.length).toBeGreaterThan(0);
    for (const s of live) expect(s.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);
  });

  it('password login answers sso_required only after a correct password', async () => {
    const wrong = await call(t.app, '/api/v1/auth/login', { body: { email: techEmail, password: 'wrong password!!' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    const right = await call(t.app, '/api/v1/auth/login', { body: { email: techEmail, password: PASSWORD } });
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe('sso_required');
    expect(right.json().error.details.beginUrl).toBe(`/api/v1/auth/sso/${admin.org.slug}/begin?login_hint=${encodeURIComponent(techEmail)}`);
    expect(right.headers['set-cookie']).toBeUndefined();
  });

  it('accept-invite and password change are refused', async () => {
    const inv = await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email: `late@${domain}`, name: 'Late', role: 'technician' } });
    const invite = new URL(inv.json().inviteUrl as string).hash.replace('#i=', '');
    const acc = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite, name: 'Late', password: PASSWORD } });
    expect(acc.statusCode).toBe(403);
    expect(acc.json().error.code).toBe('sso_required');
    const pw = await call(t.app, '/api/v1/auth/password', { cookie: ssoCookie, body: { currentPassword: 'x', newPassword: 'another long password' } });
    expect(pw.statusCode).toBe(403);
    expect(pw.json().error.code).toBe('sso_required');
  });

  it('a break-glass login gets a 1 h session, is chained and mails the other admins', async () => {
    const send = vi.spyOn(t.ctx.mailer, 'send');
    const r = await call(t.app, '/api/v1/auth/login', { body: { email: admin.email, password: PASSWORD } });
    expect(r.statusCode, r.body).toBe(200);
    const line = ([] as string[]).concat(r.headers['set-cookie'] as string[]).find((c) => c.startsWith('ia_session='))!;
    expect(line).toMatch(/Max-Age=3600/);
    expect((await auditOf(t.app, admin.cookie, 'auth.break_glass_used'))[0]?.data).toEqual({ userId: admin.user.id });
    expect((await auditOf(t.app, admin.cookie, 'auth.login'))[0]?.data).toEqual({ method: 'local' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const msg = send.mock.calls[0]![0];
    expect(msg.text).toMatch(/signed in with the break-glass password at/);
    expect(send.mock.calls.map((c) => c[0].to).sort()).not.toContain(admin.email);
    expect(t.ctx.mailer.driver).toBe('log');
    send.mockRestore();
  });

  it('each break-glass login notice counts once in ia_mail_sent_total{kind="break_glass_login"} (F section 4.1e)', async () => {
    const count = async (result: 'sent' | 'failed' | 'no_mailer') =>
      (await t.ctx.metrics.mailSent.get()).values.find((v) => v.labels.kind === 'break_glass_login' && v.labels.result === result)?.value ?? 0;
    const snap = async () => ({ sent: await count('sent'), failed: await count('failed'), no_mailer: await count('no_mailer') });
    const org = (await getOrg(t.db, admin.org.id))!;
    const [me] = await t.db.select().from(userTable).where(eq(userTable.id, admin.user.id));
    const logMailer = t.ctx.mailer;
    try {
      // the `log` driver (the default): one `no_mailer` per notice, as for every other kind
      let before = await snap();
      expect(await notifyBreakGlassLogin(t.ctx, org, me!, '203.0.113.7')).toBe(0);
      expect(await snap()).toEqual({ ...before, no_mailer: before.no_mailer + 2 });
      // an SMTP transport that takes both notices: one `sent` each
      const ok = vi.fn().mockResolvedValue(true);
      t.ctx.mailer = { driver: 'smtp', send: ok };
      before = await snap();
      expect(await notifyBreakGlassLogin(t.ctx, org, me!, '203.0.113.7')).toBe(2);
      expect(ok).toHaveBeenCalledTimes(2);
      expect(ok.mock.calls[0]![0]).toMatchObject({ subject: 'IndiansAssist: break-glass sign-in', attachments: [] });
      expect(String(ok.mock.calls[0]![0].text)).toMatch(/signed in with the break-glass password at .* from 203\.0\.113\.7\./);
      expect(await snap()).toEqual({ ...before, sent: before.sent + 2 });
      // a refused send counts as `failed`, the label the other kinds use, and the next admin is still mailed
      const flaky = vi.fn().mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'EENVELOPE', responseCode: 550 })).mockResolvedValue(true);
      t.ctx.mailer = { driver: 'smtp', send: flaky };
      before = await snap();
      expect(await notifyBreakGlassLogin(t.ctx, org, me!, undefined)).toBe(1);
      expect(flaky).toHaveBeenCalledTimes(2);
      expect(await snap()).toEqual({ sent: before.sent + 1, failed: before.failed + 1, no_mailer: before.no_mailer });
      for (const c of [...ok.mock.calls, ...flaky.mock.calls]) expect(String(c[0].to)).not.toBe(admin.email);
    } finally {
      t.ctx.mailer = logMailer;
    }
  });

  it('protects the last break-glass user and clears the flag of a demoted one', async () => {
    const empty = await call(t.app, '/api/v1/orgs/current/sso/break-glass', { method: 'PUT', cookie: admin.cookie, body: { userIds: [] } });
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error.code).toBe('last_break_glass');
    // demoting one of two break-glass users is allowed and clears its flag
    const d = await call(t.app, `/api/v1/users/${secondAdmin.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'senior_technician', tier: 'p1_browser' } });
    expect(d.statusCode, d.body).toBe(200);
    const s = (await call(t.app, '/api/v1/orgs/current/sso', { cookie: admin.cookie })).json();
    expect(s.breakGlassUserIds).toEqual([admin.user.id]);
    // admin is now the last one (the third admin keeps the org from being admin-less)
    const role = await call(t.app, `/api/v1/users/${admin.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'technician' } });
    expect(role.statusCode).toBe(409);
    expect(role.json().error.code).toBe('last_break_glass');
    const dis = await call(t.app, `/api/v1/users/${admin.user.id}/status`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'disabled' } });
    expect(dis.statusCode).toBe(409);
    expect(dis.json().error.code).toBe('last_break_glass');
  });

  it('disabling SSO or removing the last verified domain while required is refused; turning it off revokes nothing', async () => {
    const off = await call(t.app, '/api/v1/orgs/current/sso', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { config: oidcConfig(fake, { enabled: false }) },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe('sso_required_on');
    const domains = (await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: admin.cookie })).json().items as { id: string }[];
    const del = await call(t.app, `/api/v1/orgs/current/sso/domains/${domains[0]!.id}`, { method: 'DELETE', cookie: admin.cookie });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('sso_required_on');
    const before = closed.length;
    const r = await patchRequired(admin, { required: false });
    expect(r.statusCode).toBe(200);
    expect(r.json().required).toBe(false);
    expect(closed.length).toBe(before);
    expect((await auditOf(t.app, admin.cookie, 'sso.required_changed'))[0]?.data).toEqual({ required: false, revokedSessions: 0 });
    // password logins work again
    const login = await call(t.app, '/api/v1/auth/login', { body: { email: techEmail, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
  });
});
