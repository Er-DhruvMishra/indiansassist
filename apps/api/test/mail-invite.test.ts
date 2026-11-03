/**
 * Phase F section 15.3 (stream mail): the `smtp` driver against the in-process fake SMTP server (`fake-smtp.ts`,
 * 127.0.0.1 only, never relays): the invitation mail and its chain entry, resend rotating the secret, the SSO-required
 * invite text, scripted 451 / 550 / hang replies never failing the invite, `requireTLS` refusing a server without
 * STARTTLS, the log driver mailing nothing, header injection through a display name, and the resend limits.
 * Every address is synthetic (`@example.test`).
 */
import { and, asc, eq } from 'drizzle-orm';
import { auditEntry, org as orgTable, user as userTable } from '@indiansassist/db';
import { inviteResendReplySchema, inviteResponseSchema } from '@indiansassist/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLimiter } from '../src/limiter.js';
import { LogMailer, SmtpMailer, smtpTransportOptions, type Mailer } from '../src/mail/mailer.js';
import { startFakeSmtp, findLink, type FakeSmtp } from './fake-smtp.js';
import { addMember, call, makeApp, PASSWORD, signup, uniq, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let fake: FakeSmtp;
let smtp: Mailer;

async function chain(orgId: string, action: string): Promise<Record<string, unknown>[]> {
  const rows = await t.db
    .select()
    .from(auditEntry)
    .where(and(eq(auditEntry.orgId, orgId), eq(auditEntry.action, action)))
    .orderBy(asc(auditEntry.seq));
  return rows.map((r) => ({ ...(r.data as Record<string, unknown>), _actor: r.actorType, _actorId: r.actorId, _seq: r.seq }));
}

async function invite(admin: Account, over: Record<string, unknown> = {}) {
  const email = `${uniq('inv')}@example.test`;
  const r = await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email, name: 'Ravi Invitee', role: 'technician', ...over } });
  return { r, email };
}

beforeAll(async () => {
  fake = await startFakeSmtp();
  t = await makeApp({ MAIL_DRIVER: 'smtp', SMTP_URL: fake.url, SMTP_REQUIRE_TLS: 'false', MAIL_FROM: 'IndiansAssist <no-reply@example.test>' });
  smtp = t.ctx.mailer;
});

afterAll(async () => {
  await t?.close();
  await fake?.close();
});

beforeEach(() => {
  t.ctx.mailer = smtp;
  t.ctx.config.mail.driver = 'smtp';
  fake.setMode('accept');
});

describe('options (rule 4.1c)', () => {
  it('answers from config only: both on with smtp', async () => {
    const r = await call(t.app, '/api/v1/auth/options');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ passwordReset: true, inviteMail: true });
  });
});

describe('invite by email (rule 4.2)', () => {
  it('mails the invitee after the commit, plain text, and chains the attempt; the link accepts once', async () => {
    const admin = await signup(t.app, { name: 'Asha Admin' });
    const { r, email } = await invite(admin);
    expect(r.statusCode, r.body).toBe(201);
    const body = inviteResponseSchema.parse(r.json());
    expect(body.mailed).toBe(true);
    expect(body.user.inviteMailedAt).toEqual(expect.any(String));
    const m = await fake.waitFor((x) => x.to.includes(email));
    expect(m.from).toBe('no-reply@example.test');
    expect(m.subject).toBe('Your invitation to IndiansAssist');
    expect(m.headers['content-type']).toMatch(/^text\/plain/);
    expect(m.raw).not.toMatch(/text\/html/i);
    expect(m.text).toContain(`Asha Admin invited you to Org `);
    expect(m.text).toContain('as a technician');
    expect(m.text).toContain('The link works once and expires on ');
    expect(findLink(m.text, '/invite#i=')).toBe(body.inviteUrl);
    const [entry] = await chain(admin.org.id, 'user.invite_mailed');
    expect(entry).toMatchObject({ userId: body.user.id, delivered: true, cause: null, _actor: 'user', _actorId: admin.user.id });
    // The invited user listed with the date.
    const list = await call(t.app, '/api/v1/users', { cookie: admin.cookie });
    expect((list.json().items as { id: string; inviteMailedAt: string | null }[]).find((u) => u.id === body.user.id)?.inviteMailedAt).toBe(body.user.inviteMailedAt);
    const secret = new URL(body.inviteUrl).hash.replace('#i=', '');
    const acc = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite: secret, name: 'Ravi', password: PASSWORD } });
    expect(acc.statusCode, acc.body).toBe(200);
  });

  it('sendEmail: false mails nothing and chains nothing', async () => {
    const admin = await signup(t.app);
    const before = fake.messages.length;
    const { r } = await invite(admin, { sendEmail: false });
    expect(r.statusCode).toBe(201);
    expect(r.json().mailed).toBe(false);
    expect(r.json().user.inviteMailedAt).toBeNull();
    expect(fake.messages.length).toBe(before);
    expect(await chain(admin.org.id, 'user.invite_mailed')).toEqual([]);
  });

  it('451, 550 and a hang never fail the invite: mailed false, send_failed chained, no date', async () => {
    const admin = await signup(t.app);
    for (const mode of ['tempfail', 'permfail'] as const) {
      fake.script(mode);
      const { r } = await invite(admin);
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().mailed).toBe(false);
      expect(r.json().user.inviteMailedAt).toBeNull();
      expect(r.json().inviteUrl).toContain('/invite#i=');
    }
    t.ctx.mailer = new SmtpMailer(fake.url, 'IndiansAssist <no-reply@example.test>', {
      timeouts: { connectionMs: 500, greetingMs: 500, socketMs: 800, overallMs: 1200 },
    });
    fake.script('hang');
    const t0 = Date.now();
    const { r } = await invite(admin);
    expect(r.statusCode).toBe(201);
    expect(r.json().mailed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
    const entries = await chain(admin.org.id, 'user.invite_mailed');
    expect(entries.map((e) => [e['delivered'], e['cause']])).toEqual([
      [false, 'send_failed'],
      [false, 'send_failed'],
      [false, 'send_failed'],
    ]);
  });

  it('an SSO-required org gets the single sign-on link instead of the invitation link (rule 4.2b)', async () => {
    const admin = await signup(t.app);
    await t.db.update(orgTable).set({ ssoRequired: true }).where(eq(orgTable.id, admin.org.id));
    const { r, email } = await invite(admin);
    expect(r.statusCode, r.body).toBe(201);
    const m = await fake.waitFor((x) => x.to.includes(email));
    expect(m.text).toContain("Sign in with your organisation's single sign-on: http://localhost:4000/api/v1/auth/sso/");
    expect(m.text).toContain(`/${admin.org.slug}/begin?login_hint=`);
    expect(m.text).not.toContain('/invite#i=');
    expect(m.text).not.toContain('set your name and password');
    await t.db.update(orgTable).set({ ssoRequired: false }).where(eq(orgTable.id, admin.org.id));
  });

  it('a display name cannot inject a header or a line (rule 4.1a)', async () => {
    const admin = await signup(t.app);
    await t.db.update(userTable).set({ name: 'Mallory\r\nBcc: victim@example.test\r\n\r\nInjected' }).where(eq(userTable.id, admin.user.id));
    const { r, email } = await invite(admin);
    expect(r.statusCode).toBe(201);
    const m = await fake.waitFor((x) => x.to.includes(email));
    expect(m.to).toEqual([email]);
    expect(m.headers['bcc']).toBeUndefined();
    // sanitiseText drops the control characters, so the whole name stays on the first line of the body.
    expect(m.text.split('\n')[0]).toMatch(/^Mallory ?Bcc: victim@example\.test ?Injected invited you to /);
    expect(m.raw.split(/\r?\n\r?\n/)[0]).not.toMatch(/victim/);
  });
});

describe('resend (rule 4.2c)', () => {
  it('rotates the secret, resets the expiry, mails again and chains resent before mailed', async () => {
    const admin = await signup(t.app);
    const { r, email } = await invite(admin);
    const first = r.json() as { user: { id: string }; inviteUrl: string };
    const res = await call(t.app, `/api/v1/users/${first.user.id}/invite/resend`, { cookie: admin.cookie, body: {} });
    expect(res.statusCode, res.body).toBe(200);
    const body = inviteResendReplySchema.parse(res.json());
    expect(body.mailed).toBe(true);
    expect(body.inviteUrl).not.toBe(first.inviteUrl);
    expect(Date.parse(body.inviteExpiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    await fake.waitFor((x) => x.to.includes(email) && (findLink(x.text, '/invite#i=') ?? '') === body.inviteUrl);
    expect(fake.to(email)).toHaveLength(2);
    const resent = await chain(admin.org.id, 'user.invite_resent');
    const mailed = await chain(admin.org.id, 'user.invite_mailed');
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ userId: first.user.id, _actor: 'user' });
    expect(mailed).toHaveLength(2);
    expect(Number(mailed[1]!['_seq'])).toBeGreaterThan(Number(resent[0]!['_seq']));
    // The earlier link stopped working; the new one works once.
    const old = new URL(first.inviteUrl).hash.replace('#i=', '');
    const stale = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite: old, name: 'Ravi', password: PASSWORD } });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('invite_invalid');
    const fresh = new URL(body.inviteUrl).hash.replace('#i=', '');
    const ok = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite: fresh, name: 'Ravi', password: PASSWORD } });
    expect(ok.statusCode, ok.body).toBe(200);
    // Now active: a resend is a bad state.
    const again = await call(t.app, `/api/v1/users/${first.user.id}/invite/resend`, { cookie: admin.cookie, body: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('bad_state');
  });

  it('is org_admin only, 404 across orgs, and limited to 5 per user and 30 per org per hour', async () => {
    const admin = await signup(t.app);
    const tech = await addMember(t.app, admin, 'technician');
    const other = await signup(t.app);
    const { r } = await invite(admin);
    const id = r.json().user.id as string;
    expect((await call(t.app, `/api/v1/users/${id}/invite/resend`, { cookie: tech.cookie, body: {} })).statusCode).toBe(403);
    const cross = await call(t.app, `/api/v1/users/${id}/invite/resend`, { cookie: other.cookie, body: {} });
    expect(cross.statusCode).toBe(404);
    expect((await call(t.app, '/api/v1/users/not-a-uuid/invite/resend', { cookie: admin.cookie, body: {} })).statusCode).toBe(404);
    const saved = t.ctx.limiter;
    t.ctx.limiter = new MemoryLimiter(false);
    try {
      for (let i = 0; i < 5; i += 1) expect((await call(t.app, `/api/v1/users/${id}/invite/resend`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
      const sixth = await call(t.app, `/api/v1/users/${id}/invite/resend`, { cookie: admin.cookie, body: {} });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().error.code).toBe('rate_limited');
      // The org bucket: 25 more across other invitees reach 30, the next one is refused.
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) ids.push((await invite(admin, { sendEmail: false })).r.json().user.id as string);
      let ok = 0;
      let refused = 0;
      for (let n = 0; n < 26; n += 1) {
        const res = await call(t.app, `/api/v1/users/${ids[n % ids.length]}/invite/resend`, { cookie: admin.cookie, body: {} });
        if (res.statusCode === 200) ok += 1;
        else if (res.statusCode === 429) refused += 1;
      }
      expect(ok).toBe(25);
      expect(refused).toBe(1);
    } finally {
      t.ctx.limiter = saved;
    }
  });
});

describe('transport rules (rule 4.1b)', () => {
  it('requireTLS refuses a server that offers no STARTTLS: nothing is delivered, the invite still succeeds', async () => {
    const admin = await signup(t.app);
    t.ctx.mailer = new SmtpMailer(fake.url, 'IndiansAssist <no-reply@example.test>', { requireTls: true });
    const before = fake.messages.length;
    const { r } = await invite(admin);
    expect(r.statusCode).toBe(201);
    expect(r.json().mailed).toBe(false);
    expect(fake.commands).toContain('STARTTLS');
    expect(fake.messages.length).toBe(before);
  });

  it('a URL parameter cannot weaken the TLS rule', () => {
    const o = smtpTransportOptions('smtp://relay.example.test:587/?ignoreTLS=true&requireTLS=false&opportunisticTLS=true', { requireTls: true });
    expect(o).toMatchObject({ host: 'relay.example.test', port: 587, secure: false, requireTLS: true, ignoreTLS: false, opportunisticTLS: false });
    expect(smtpTransportOptions('smtps://u%40x:p%3Aw@relay.example.test', { requireTls: true })).toMatchObject({
      secure: true,
      auth: { user: 'u@x', pass: 'p:w' },
    });
    expect(() => smtpTransportOptions('http://relay.example.test')).toThrow();
  });

  it('the log driver: options off, an invite mails nothing and chains nothing', async () => {
    const admin = await signup(t.app);
    t.ctx.config.mail.driver = 'log';
    t.ctx.mailer = new LogMailer(t.app.log);
    const opts = await call(t.app, '/api/v1/auth/options');
    expect(opts.json()).toEqual({ passwordReset: false, inviteMail: false });
    const before = fake.messages.length;
    const { r } = await invite(admin, { sendEmail: true });
    expect(r.statusCode).toBe(201);
    expect(r.json().mailed).toBe(false);
    expect(fake.messages.length).toBe(before);
    expect(await chain(admin.org.id, 'user.invite_mailed')).toEqual([]);
    const res = await call(t.app, `/api/v1/users/${r.json().user.id}/invite/resend`, { cookie: admin.cookie, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().mailed).toBe(false);
    expect(fake.messages.length).toBe(before);
  });
});

