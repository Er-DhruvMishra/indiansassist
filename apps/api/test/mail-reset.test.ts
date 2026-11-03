/**
 * Phase F section 15.3 (stream mail): password reset over the `smtp` driver and the in-process fake SMTP server.
 * Identical replies and comparable timing for known and unknown emails (the work runs after the reply); the
 * eligibility table; one 3-per-hour cap shared by reset links and SSO notices (`ia:resetmail:`); single use, expiry,
 * supersede; confirm revoking every session and closing sockets 4401 without minting a session; the break-glass
 * notice; every chain entry; the per-IP limits; and no token in any log line, chain entry or response (only in the
 * mail). Every address is synthetic (`@example.test`).
 */
import { and, asc, eq } from 'drizzle-orm';
import { auditEntry, authSession, org as orgTable, passwordReset, user as userTable } from '@indiansassist/db';
import { LIMITS, sha256Hex } from '@indiansassist/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LogMailer, SmtpMailer, type Mailer } from '../src/mail/mailer.js';
import { resetMailKey } from '../src/mail/reset.js';
import { settleMailWork } from '../src/mail/send.js';
import { sweepMailTokens } from '../src/mail/sweep.js';
import { findLink, startFakeSmtp, type FakeSmtp } from './fake-smtp.js';
import { addMember, call, captureLogLines, cookieOf, listen, makeApp, PASSWORD, signup, uniq, type Account, type TestApp } from './helpers.js';
import { Kit } from './signal-kit.js';

const NEW_PASSWORD = 'a brand new passphrase';
const FROM = 'IndiansAssist <no-reply@example.test>';
const SSO_CONFIG = {
  v: 1,
  protocol: 'oidc',
  enabled: true,
  displayName: 'Example IdP',
  oidc: {
    issuer: 'https://idp.example.test',
    clientId: 'client-e2e',
    tokenEndpointAuth: 'client_secret_basic',
    scopes: ['openid', 'email', 'profile'],
    emailClaim: 'email',
    nameClaim: 'name',
    groupsClaim: 'groups',
    requiredClaims: [],
  },
  saml: null,
  jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
  sessionMaxAgeHours: 12,
};

let t: TestApp;
let fake: FakeSmtp;
let smtp: Mailer;
let logLines: string[];
let kit: Kit;
/** Every token seen in a mail, for the final leak check. */
const tokens: string[] = [];

/** Mails to `email` other than the invitation `addMember` triggers. */
function mailsTo(email: string) {
  return fake.to(email).filter((m) => m.subject !== 'Your invitation to IndiansAssist');
}

async function chain(orgId: string, action: string): Promise<Record<string, unknown>[]> {
  const rows = await t.db
    .select()
    .from(auditEntry)
    .where(and(eq(auditEntry.orgId, orgId), eq(auditEntry.action, action)))
    .orderBy(asc(auditEntry.seq));
  return rows.map((r) => ({ ...(r.data as Record<string, unknown>), _actor: r.actorType }));
}

async function request(email: string) {
  const r = await call(t.app, '/api/v1/auth/password-reset/request', { body: { email } });
  return r;
}

/** Requests a reset, waits for the after-reply work, and returns the token mailed to `email` (or null). */
async function requestAndToken(email: string): Promise<string | null> {
  const before = mailsTo(email).length;
  const r = await request(email);
  expect(r.statusCode).toBe(202);
  await settleMailWork(t.ctx);
  const mails = mailsTo(email);
  if (mails.length === before) return null;
  const link = findLink(mails.at(-1)!.text, '/reset#t=');
  if (!link) return null;
  const token = new URL(link).hash.replace('#t=', '');
  tokens.push(token);
  return token;
}

async function confirm(token: string, newPassword = NEW_PASSWORD) {
  return call(t.app, '/api/v1/auth/password-reset/confirm', { body: { token, newPassword } });
}

async function login(email: string, password: string) {
  return call(t.app, '/api/v1/auth/login', { body: { email, password } });
}

async function member(admin: Account, role = 'technician'): Promise<Account & { email: string }> {
  const acc = await addMember(t.app, admin, role);
  const [row] = await t.db.select().from(userTable).where(eq(userTable.id, acc.user.id));
  return { ...acc, email: row!.email };
}

async function adminWithEmail(): Promise<Account & { email: string }> {
  const email = `${uniq('admin')}@example.test`;
  return { ...(await signup(t.app, { email, name: 'Asha Admin' })), email };
}

async function metric(result: string): Promise<number> {
  const m = await t.ctx.metrics.passwordResets.get();
  return m.values.find((v) => v.labels['result'] === result)?.value ?? 0;
}

beforeAll(async () => {
  fake = await startFakeSmtp();
  t = await makeApp({ MAIL_DRIVER: 'smtp', SMTP_URL: fake.url, SMTP_REQUIRE_TLS: 'false', MAIL_FROM: FROM }, { tickMs: 50 }, { logLevel: 'info' });
  logLines = captureLogLines(t.app);
  smtp = t.ctx.mailer;
  kit = new Kit(t, await listen(t.app));
});

afterAll(async () => {
  kit?.closeAll();
  await t?.close();
  await fake?.close();
});

beforeEach(() => {
  t.ctx.mailer = smtp;
  t.ctx.config.mail.driver = 'smtp';
  fake.setMode('accept');
});

describe('request (rules 4.3a, 4.3b, 4.3g)', () => {
  it('answers a known and an unknown email identically and quickly, even while the relay hangs', async () => {
    const admin = await adminWithEmail();
    const unknown = `${uniq('nobody')}@example.test`;
    // The relay hangs: if the mail were sent before the reply, the known email would answer late.
    t.ctx.mailer = new SmtpMailer(fake.url, FROM, { timeouts: { connectionMs: 800, greetingMs: 800, socketMs: 800, overallMs: 1000 } });
    fake.setMode('hang');
    await request(`${uniq('warm')}@example.test`);
    await settleMailWork(t.ctx);
    const times: Record<string, number[]> = { known: [], unknown: [] };
    const bodies = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      for (const [k, email] of [
        ['known', admin.email],
        ['unknown', unknown],
      ] as const) {
        const t0 = performance.now();
        const r = await request(email);
        times[k]!.push(performance.now() - t0);
        expect(r.statusCode).toBe(202);
        bodies.add(`${r.statusCode} ${r.body} ${r.headers['content-type'] ?? ''}`);
        expect(r.headers['set-cookie']).toBeUndefined();
        // Each measurement starts with no after-reply work running (one in-process PGlite shares the thread).
        await settleMailWork(t.ctx);
      }
    }
    expect([...bodies]).toEqual(['202 {} application/json; charset=utf-8']);
    const median = (k: string) => [...times[k]!].sort((x, y) => x - y)[1]!;
    // Section 12: the reply does not wait for the lookup or the relay (which hangs for a second here).
    expect(median('known')).toBeLessThan(150);
    expect(median('unknown')).toBeLessThan(150);
    expect(Math.abs(median('known') - median('unknown'))).toBeLessThan(100);
    expect(Math.max(...times['known']!)).toBeLessThan(800);
    await settleMailWork(t.ctx);
  });

  it('the eligibility table: active and break-glass get a link; invited, disabled and password-less get nothing; SSO users get the notice', async () => {
    const admin = await adminWithEmail();
    const unknownBefore = await metric('unknown');
    // active
    expect(await requestAndToken(admin.email)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // invited (never accepted)
    const invitedEmail = `${uniq('invited')}@example.test`;
    expect((await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email: invitedEmail, name: 'Invited', role: 'technician', sendEmail: false } })).statusCode).toBe(201);
    expect(await requestAndToken(invitedEmail)).toBeNull();
    expect(mailsTo(invitedEmail)).toHaveLength(0);
    // disabled
    const off = await member(admin);
    expect((await call(t.app, `/api/v1/users/${off.user.id}/status`, { method: 'PATCH', cookie: admin.cookie, body: { status: 'disabled' } })).statusCode).toBe(200);
    expect(await requestAndToken(off.email)).toBeNull();
    expect(mailsTo(off.email)).toHaveLength(0);
    // no password, no SSO configured: nothing
    const jit = await member(admin);
    await t.db.update(userTable).set({ passwordHash: null }).where(eq(userTable.id, jit.user.id));
    expect(await requestAndToken(jit.email)).toBeNull();
    expect(mailsTo(jit.email)).toHaveLength(0);
    // unknown
    expect(await requestAndToken(`${uniq('ghost')}@example.test`)).toBeNull();
    expect(await metric('unknown')).toBe(unknownBefore + 4);
    // no password with SSO configured: the notice, never a link
    await t.db.update(orgTable).set({ ssoConfig: SSO_CONFIG }).where(eq(orgTable.id, admin.org.id));
    expect(await requestAndToken(jit.email)).toBeNull();
    const notice = mailsTo(jit.email);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.subject).toBe('Signing in to IndiansAssist');
    expect(notice[0]!.text).toContain('there is no password to reset. Sign in here: http://localhost:4000/api/v1/auth/sso/');
    expect(notice[0]!.text).not.toContain('/reset#t=');
    // SSO required: a member gets the notice; the break-glass admin gets a link
    const tech = await member(admin);
    await t.db.update(userTable).set({ ssoBreakGlass: true }).where(eq(userTable.id, admin.user.id));
    await t.db.update(orgTable).set({ ssoRequired: true }).where(eq(orgTable.id, admin.org.id));
    expect(await requestAndToken(tech.email)).toBeNull();
    expect(mailsTo(tech.email).at(-1)!.text).toContain('Your organisation signs in with single sign-on');
    expect(await requestAndToken(admin.email)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const outcomes = (await chain(admin.org.id, 'auth.password_reset_requested')).map((e) => [e['userId'], e['outcome'], e['_actor']]);
    expect(outcomes).toEqual([
      [admin.user.id, 'mailed', 'system'],
      [jit.user.id, 'sso_notice', 'system'],
      [tech.user.id, 'sso_notice', 'system'],
      [admin.user.id, 'mailed', 'system'],
    ]);
  });

  it('reset links and SSO notices share one 3-per-hour cap, so an SSO user cannot be mail-bombed', async () => {
    const admin = await adminWithEmail();
    const tech = await member(admin);
    await t.db.update(orgTable).set({ ssoRequired: true, ssoConfig: SSO_CONFIG }).where(eq(orgTable.id, admin.org.id));
    for (let i = 0; i < 6; i += 1) await request(tech.email);
    await settleMailWork(t.ctx);
    expect(mailsTo(tech.email)).toHaveLength(LIMITS.passwordResetPerHour);
    const outcomes = (await chain(admin.org.id, 'auth.password_reset_requested')).filter((e) => e['userId'] === tech.user.id).map((e) => e['outcome']);
    // The six ran concurrently after their replies, so the chain order is not the request order.
    expect(outcomes.sort()).toEqual(['sso_notice', 'sso_notice', 'sso_notice', 'throttled', 'throttled', 'throttled']);
    // The same counter caps links: a user who used up the hour on notices gets no link either.
    await t.db.update(orgTable).set({ ssoRequired: false }).where(eq(orgTable.id, admin.org.id));
    expect(await requestAndToken(tech.email)).toBeNull();
    expect(await t.ctx.presence.incr(resetMailKey(tech.user.id), 3600)).toBeGreaterThan(LIMITS.passwordResetPerHour);
    // Links alone: three, then throttled.
    const other = await member(admin);
    for (let i = 0; i < 4; i += 1) await request(other.email);
    await settleMailWork(t.ctx);
    expect(mailsTo(other.email)).toHaveLength(3);
    for (const m of mailsTo(other.email)) tokens.push(new URL(findLink(m.text, '/reset#t=')!).hash.replace('#t=', ''));
  });

  it('send failures and the log driver are chained as send_failed and no_mailer; neither leaves a usable token', async () => {
    const admin = await adminWithEmail();
    fake.script('permfail');
    expect(await requestAndToken(admin.email)).toBeNull();
    const rows = await t.db.select().from(passwordReset).where(eq(passwordReset.userId, admin.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedAt).not.toBeNull();
    t.ctx.config.mail.driver = 'log';
    t.ctx.mailer = new LogMailer(t.app.log);
    expect(await requestAndToken(admin.email)).toBeNull();
    expect(await t.db.select().from(passwordReset).where(eq(passwordReset.userId, admin.user.id))).toHaveLength(1);
    expect((await chain(admin.org.id, 'auth.password_reset_requested')).map((e) => e['outcome'])).toEqual(['send_failed', 'no_mailer']);
  });

  it('the mail names the org and the expiry, has a fragment link, and never the requesting IP', async () => {
    const admin = await adminWithEmail();
    const r = await call(t.app, '/api/v1/auth/password-reset/request', { body: { email: admin.email.toUpperCase() }, headers: { 'x-forwarded-for': '203.0.113.77' } });
    expect(r.statusCode).toBe(202);
    await settleMailWork(t.ctx);
    const m = mailsTo(admin.email).at(-1)!;
    expect(m.subject).toBe('Reset your IndiansAssist password');
    expect(m.headers['content-type']).toMatch(/^text\/plain/);
    expect(m.text).toContain(`account at Org `);
    expect(m.text).toMatch(/expires at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(m.text).toContain('If you did not ask for this, ignore this email; your password is unchanged.');
    expect(m.text).toMatch(/http:\/\/localhost:5173\/reset#t=[A-Za-z0-9_-]{43}/);
    expect(m.text).not.toMatch(/127\.0\.0\.1|203\.0\.113\.77/);
    tokens.push(new URL(findLink(m.text, '/reset#t=')!).hash.replace('#t=', ''));
  });
});

describe('confirm (rule 4.3e)', () => {
  it('sets the password, uses the token once, revokes every session, closes sockets 4401, mints no session', async () => {
    const admin = await adminWithEmail();
    const second = cookieOf(await login(admin.email, PASSWORD));
    const sock = await kit.assistOnline(admin);
    const token = (await requestAndToken(admin.email))!;
    const r = await confirm(token);
    expect(r.statusCode, r.body).toBe(204);
    expect(r.body).toBe('');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(await sock.closed()).toBe(4401);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: admin.cookie })).statusCode).toBe(401);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: second })).statusCode).toBe(401);
    const live = await t.db.select().from(authSession).where(eq(authSession.userId, admin.user.id));
    expect(live.every((s) => s.revokedAt !== null)).toBe(true);
    expect((await login(admin.email, PASSWORD)).statusCode).toBe(401);
    expect((await login(admin.email, NEW_PASSWORD)).statusCode).toBe(200);
    const [entry] = await chain(admin.org.id, 'auth.password_reset');
    expect(entry).toMatchObject({ userId: admin.user.id, revokedSessions: 2, _actor: 'user' });
    // Single use.
    const again = await confirm(token, 'yet another passphrase');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('reset_invalid');
  });

  it('one reset_invalid for unknown, superseded and expired tokens; validation_failed for a malformed body', async () => {
    const admin = await adminWithEmail();
    const first = (await requestAndToken(admin.email))!;
    const second = (await requestAndToken(admin.email))!;
    const unknown = Buffer.alloc(32, 7).toString('base64url');
    const answers = [];
    for (const tok of [unknown, first]) {
      const r = await confirm(tok);
      answers.push([r.statusCode, r.json().error.code, r.json().error.message]);
    }
    await t.db.update(passwordReset).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passwordReset.tokenHash, sha256Hex(second)));
    const expired = await confirm(second);
    answers.push([expired.statusCode, expired.json().error.code, expired.json().error.message]);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]!.slice(0, 2)).toEqual([400, 'reset_invalid']);
    expect((await confirm('short')).json().error.code).toBe('validation_failed');
    expect((await confirm(Buffer.alloc(32, 1).toString('base64url'), 'short')).json().error.code).toBe('validation_failed');
    expect((await login(admin.email, PASSWORD)).statusCode).toBe(200);
  });

  it('an account that stopped being eligible: 403 sso_required under SSO, else reset_invalid', async () => {
    const admin = await adminWithEmail();
    const tech = await member(admin);
    const techToken = (await requestAndToken(tech.email))!;
    const adminToken = (await requestAndToken(admin.email))!;
    await t.db.update(orgTable).set({ ssoRequired: true, ssoConfig: SSO_CONFIG }).where(eq(orgTable.id, admin.org.id));
    const sso = await confirm(techToken);
    expect(sso.statusCode).toBe(403);
    expect(sso.json().error.code).toBe('sso_required');
    await t.db.update(orgTable).set({ ssoRequired: false }).where(eq(orgTable.id, admin.org.id));
    await t.db.update(userTable).set({ status: 'disabled' }).where(eq(userTable.id, admin.user.id));
    expect((await confirm(adminToken)).json().error.code).toBe('reset_invalid');
  });

  it('a break-glass reset under SSO required mails every other active org_admin', async () => {
    const admin = await adminWithEmail();
    const other = await member(admin, 'org_admin');
    const tech = await member(admin);
    await t.db.update(userTable).set({ ssoBreakGlass: true }).where(eq(userTable.id, admin.user.id));
    await t.db.update(orgTable).set({ ssoRequired: true, ssoConfig: SSO_CONFIG }).where(eq(orgTable.id, admin.org.id));
    const token = (await requestAndToken(admin.email))!;
    expect((await confirm(token)).statusCode).toBe(204);
    await settleMailWork(t.ctx);
    const notice = mailsTo(other.email);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.subject).toBe('IndiansAssist: break-glass password reset');
    expect(notice[0]!.text).toMatch(/^Asha Admin reset the break-glass password at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\./);
    expect(mailsTo(tech.email)).toHaveLength(0);
    expect(mailsTo(admin.email).filter((m) => m.subject.includes('break-glass'))).toHaveLength(0);
  });
});

describe('sweep (rule 4.3h)', () => {
  it('deletes rows 24 h after expiry or use, and keeps the rest', async () => {
    const admin = await adminWithEmail();
    const token = (await requestAndToken(admin.email))!;
    const now = new Date();
    await sweepMailTokens(t.ctx, now);
    expect(await t.db.select().from(passwordReset).where(eq(passwordReset.userId, admin.user.id))).toHaveLength(1);
    await sweepMailTokens(t.ctx, new Date(now.getTime() + 25 * 3600_000));
    expect(await t.db.select().from(passwordReset).where(eq(passwordReset.userId, admin.user.id))).toHaveLength(0);
    expect((await confirm(token)).json().error.code).toBe('reset_invalid');
  });
});

describe('limits (section 2.3)', () => {
  it('request 5 / minute and confirm 10 / minute per IP', async () => {
    const lim = await makeApp({ RATE_LIMIT_DISABLED: 'false', MAIL_DRIVER: 'smtp', SMTP_URL: fake.url, SMTP_REQUIRE_TLS: 'false' });
    try {
      const hit = (url: string, body: unknown, ip: string) =>
        lim.app.inject({ method: 'POST', url, remoteAddress: ip, headers: { 'content-type': 'application/json', 'x-requested-with': 'IndiansAssist' }, payload: JSON.stringify(body) });
      const codes: number[] = [];
      for (let i = 0; i < 6; i += 1) codes.push((await hit('/api/v1/auth/password-reset/request', { email: `${uniq('rl')}@example.test` }, '198.51.100.1')).statusCode);
      expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
      expect((await hit('/api/v1/auth/password-reset/request', { email: 'x@example.test' }, '198.51.100.2')).statusCode).toBe(202);
      const conf: number[] = [];
      for (let i = 0; i < 11; i += 1)
        conf.push((await hit('/api/v1/auth/password-reset/confirm', { token: Buffer.alloc(32, i).toString('base64url'), newPassword: NEW_PASSWORD }, '198.51.100.3')).statusCode);
      expect(conf.slice(0, 10).every((c) => c === 400)).toBe(true);
      expect(conf[10]).toBe(429);
      await settleMailWork(lim.ctx);
    } finally {
      await lim.close();
    }
  });
});

describe('secrets stay out of logs, the chain and replies', () => {
  it('no mailed token appears in any log line or chain entry', async () => {
    expect(tokens.length).toBeGreaterThan(5);
    const logs = logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const tok of tokens) expect(logs).not.toContain(tok);
    expect(logs).not.toContain('/reset#t=');
    expect(logs).not.toContain('/invite#i=');
    expect(logs).not.toContain(fake.url.replace('smtp://', ''));
    const all = JSON.stringify(await t.db.select().from(auditEntry));
    for (const tok of tokens) {
      expect(all).not.toContain(tok);
      expect(all).not.toContain(sha256Hex(tok));
    }
  });
});
