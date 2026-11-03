/**
 * Phase F section 5 (docs/specs/phase-f-contracts.md 5.1, 5.2, 5.6, 15.4): the org erasure state machine. The
 * second-admin rule (an approver of at least 7 days, not invited or promoted by the requester), fresh sign-in and the
 * typed slug, `erasure_exists`, approval, cancel from every open state (also after the request and approve buckets are
 * exhausted), expiry, the single-admin path (link, re-auth, 14 days; refused after a recent demotion and when an
 * approver exists), the admin set frozen while open, the mails of 5.2d, what each role reads, the residency block,
 * and the public certificate routes answering 404 until completion. Every address is synthetic.
 */
import { randomUUID } from 'node:crypto';
import { auditEntry, authSession, getErasure, orgErasure, user } from '@indiansassist/db';
import { LIMITS, erasureReplySchema, erasureStatusReplySchema, residencyReportSchema } from '@indiansassist/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MailMessage, Mailer } from '../src/mail/mailer.js';
import { sweepErasures } from '../src/erasure/sweep.js';
import { addMember, call, signup, type Account, type TestApp, makeApp } from './helpers.js';

const DAY = 86_400_000;
let t: TestApp;
let sent: MailMessage[] = [];
const fakeSmtp: Mailer = {
  driver: 'smtp',
  async send(m) {
    sent.push(m);
    return true;
  },
};
const logDriver = (): Mailer => ({ driver: 'log', send: async () => true });

beforeAll(async () => {
  t = await makeApp({ API_ORIGIN: 'http://localhost:4145' });
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  sent = [];
  (t.ctx as { mailer: Mailer }).mailer = logDriver();
});

/** An eligible approver: org_admin for `days` days, granted by `by` (null: nobody). */
async function setRole(userId: string, days: number, by: string | null = null): Promise<void> {
  await t.db.update(user).set({ roleSince: new Date(Date.now() - days * DAY), roleGrantedBy: by }).where(eq(user.id, userId));
}

/** Makes every cookie session of the user older than the 15-minute re-authentication window. */
async function staleSignIn(userId: string): Promise<void> {
  await t.db.update(authSession).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(authSession.userId, userId));
}

async function freshSignIn(userId: string): Promise<void> {
  await t.db.update(authSession).set({ createdAt: new Date() }).where(eq(authSession.userId, userId));
}

const request = (a: Account, body: Record<string, unknown> = {}) => call(t.app, '/api/v1/orgs/current/erasure', { cookie: a.cookie, body: { confirmSlug: a.org.slug, ...body } });
const approve = (a: Account, id: string, slug = a.org.slug) => call(t.app, `/api/v1/orgs/current/erasure/${id}/approve`, { cookie: a.cookie, body: { confirmSlug: slug } });
const cancel = (a: Account, id: string) => call(t.app, `/api/v1/orgs/current/erasure/${id}/cancel`, { cookie: a.cookie, body: {} });
const status = (a: Account) => call(t.app, '/api/v1/orgs/current/erasure', { cookie: a.cookie });

async function chain(orgId: string, action: string): Promise<Record<string, unknown>[]> {
  const rows = await t.db.select({ data: auditEntry.data }).from(auditEntry).where(and(eq(auditEntry.orgId, orgId), eq(auditEntry.action, action))).orderBy(asc(auditEntry.seq));
  return rows.map((r) => r.data as Record<string, unknown>);
}

/** An org with admin A (signup) and an eligible second admin B (8 days, granted by nobody). */
async function twoAdmins(): Promise<{ a: Account; b: Account }> {
  const a = await signup(t.app);
  const b = await addMember(t.app, a, 'org_admin', 'Second Admin');
  await setRole(b.user.id, 8, null);
  return { a, b };
}

describe('request (5.2a, 5.2b)', () => {
  it('needs org_admin, a sign-in from the last 15 minutes and the typed slug', async () => {
    const { a, b } = await twoAdmins();
    const tech = await addMember(t.app, a, 'technician');
    expect((await request(tech)).statusCode).toBe(403);
    await staleSignIn(a.user.id);
    const stale = await request(a);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('reauth_required');
    await freshSignIn(a.user.id);
    const wrong = await request(a, { confirmSlug: `${a.org.slug}-x` });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('erasure_confirm_mismatch');
    const ok = await request(a, { reason: 'Closing the business (synthetic)' });
    expect(ok.statusCode).toBe(201);
    const body = erasureReplySchema.parse(ok.json());
    expect(body.erasure).toMatchObject({ state: 'pending_approval', requestedBy: { id: a.user.id }, approvedBy: null, coolingOffUntil: null });
    expect(body.erasure.certificateUrl).toBe(`http://localhost:4145/api/v1/erasures/${body.erasure.id}/certificate`);
    expect(body.confirmUrl).toBeUndefined();
    // Chained without the reason; the reason sits in the row only.
    const entries = await chain(a.org.id, 'org.erasure_requested');
    expect(entries).toEqual([{ erasureId: body.erasure.id, solo: false }]);
    expect((await getErasure(t.db, body.erasure.id))!.reason).toBe('Closing the business (synthetic)');
    // A second open request is refused.
    const again = await request(b);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('erasure_exists');
  });

  it('needs an eligible approver: not the requester, at least 7 days, not invited or promoted by the requester', async () => {
    const a = await signup(t.app);
    const only = await request(a);
    expect(only.statusCode).toBe(409);
    expect(only.json().error).toMatchObject({ code: 'erasure_second_admin', details: { soloAvailable: true } });
    // B invited by A as org_admin: young and granted by A.
    const b = await addMember(t.app, a, 'org_admin', 'Invited Admin');
    expect((await request(a)).json().error).toMatchObject({ code: 'erasure_second_admin', details: { soloAvailable: false } });
    // Old enough but still granted by A: the accomplice path stays closed.
    await setRole(b.user.id, 30, a.user.id);
    expect((await request(a)).json().error.code).toBe('erasure_second_admin');
    // Granted by A but six days old: still not eligible for the other direction either (B asks, A approves).
    await setRole(a.user.id, 6, null);
    expect((await request(b)).json().error.code).toBe('erasure_second_admin');
    await setRole(a.user.id, 7.01, null);
    expect((await request(b)).statusCode).toBe(201);
  });
});

describe('approve (5.2b) and cancel (5.1)', () => {
  it('approval by the requester, an admin of fewer than 7 days, or one the requester promoted is refused', async () => {
    const { a, b } = await twoAdmins();
    const promoted = await addMember(t.app, b, 'technician', 'Promoted By A');
    expect((await call(t.app, `/api/v1/users/${promoted.user.id}/role`, { method: 'PATCH', cookie: a.cookie, body: { role: 'org_admin' } })).statusCode).toBe(200);
    await setRole(promoted.user.id, 30, a.user.id);
    const young = await addMember(t.app, b, 'org_admin', 'Young Admin');
    await setRole(young.user.id, 3, b.user.id);
    const id = (await request(a)).json().erasure.id as string;
    for (const who of [a, promoted, young]) {
      await freshSignIn(who.user.id);
      const r = await approve(who, id);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('erasure_second_admin');
    }
    // Slug, re-authentication and 404 checks for the eligible one.
    expect((await approve(b, id, 'wrong-slug')).json().error.code).toBe('erasure_confirm_mismatch');
    await staleSignIn(b.user.id);
    expect((await approve(b, id)).json().error.code).toBe('reauth_required');
    await freshSignIn(b.user.id);
    expect((await approve(b, randomUUID())).statusCode).toBe(404);
    const other = await signup(t.app);
    expect((await call(t.app, `/api/v1/orgs/current/erasure/${id}/approve`, { cookie: other.cookie, body: { confirmSlug: other.org.slug } })).statusCode).toBe(404);
    const ok = await approve(b, id);
    expect(ok.statusCode).toBe(200);
    const e = ok.json().erasure;
    expect(e).toMatchObject({ state: 'cooling_off', approvedBy: { id: b.user.id, name: 'Second Admin' } });
    const until = Date.parse(e.coolingOffUntil);
    expect(Math.abs(until - (Date.now() + LIMITS.erasureCoolingOffDays * DAY))).toBeLessThan(60_000);
    expect(await chain(a.org.id, 'org.erasure_approved')).toEqual([{ erasureId: id, coolingOffUntil: e.coolingOffUntil }]);
    expect((await approve(b, id)).json().error.code).toBe('bad_state');
    // The residency report shows the schedule.
    const rep = residencyReportSchema.parse((await call(t.app, '/api/v1/orgs/current/residency', { cookie: a.cookie })).json());
    expect(rep.erasure).toMatchObject({ available: true, state: 'cooling_off', scheduledFor: e.coolingOffUntil });
  });

  it('cancel from pending_approval and from cooling_off, by any org_admin, chained with fromState', async () => {
    const { a, b } = await twoAdmins();
    const first = (await request(a)).json().erasure.id as string;
    const c1 = await cancel(b, first);
    expect(c1.statusCode).toBe(200);
    expect(c1.json().erasure).toMatchObject({ state: 'cancelled', cancelledBy: { id: b.user.id } });
    expect((await cancel(a, first)).json().error.code).toBe('erasure_not_cancellable');
    const second = (await request(a)).json().erasure.id as string;
    expect((await approve(b, second)).statusCode).toBe(200);
    await staleSignIn(a.user.id); // cancelling needs no fresh sign-in and no slug
    expect((await cancel(a, second)).json().erasure.state).toBe('cancelled');
    expect(await chain(a.org.id, 'org.erasure_cancelled')).toEqual([
      { erasureId: first, fromState: 'pending_approval' },
      { erasureId: second, fromState: 'cooling_off' },
    ]);
    const tech = await addMember(t.app, a, 'technician');
    expect((await cancel(tech, second)).statusCode).toBe(403);
  });

  it('an unapproved request and an unconfirmed solo request expire (chained by the system)', async () => {
    const { a } = await twoAdmins();
    const id = (await request(a)).json().erasure.id as string;
    await t.db.update(orgErasure).set({ requestedAt: new Date(Date.now() - (LIMITS.erasureApprovalTtlDays * DAY + 60_000)) }).where(eq(orgErasure.id, id));
    await sweepErasures(t.ctx);
    expect((await getErasure(t.db, id))!.state).toBe('expired');
    expect(await chain(a.org.id, 'org.erasure_expired')).toEqual([{ erasureId: id }]);
    const solo = await signup(t.app);
    const sid = (await request(solo, { solo: true })).json().erasure.id as string;
    await t.db.update(orgErasure).set({ confirmExpiresAt: new Date(Date.now() - 1000) }).where(eq(orgErasure.id, sid));
    await sweepErasures(t.ctx);
    expect((await getErasure(t.db, sid))!.state).toBe('expired');
  });
});

describe('the admin set is frozen while an erasure is open (5.2e)', () => {
  it('refuses a demotion, a disable, a re-enable, a new org_admin by invite or promotion; cancelling lifts it', async () => {
    const { a, b } = await twoAdmins();
    const tech = await addMember(t.app, a, 'technician');
    const id = (await request(a)).json().erasure.id as string;
    const patch = (who: string, what: 'role' | 'status', body: Record<string, unknown>) => call(t.app, `/api/v1/users/${who}/${what}`, { method: 'PATCH', cookie: a.cookie, body });
    const refused = [
      await patch(b.user.id, 'role', { role: 'technician' }),
      await patch(b.user.id, 'status', { status: 'disabled' }),
      await patch(tech.user.id, 'role', { role: 'org_admin' }),
      await call(t.app, '/api/v1/users/invite', { cookie: a.cookie, body: { email: `frozen-${randomUUID()}@example.test`, name: 'New Admin', role: 'org_admin' } }),
    ];
    for (const r of refused) expect(r.json().error?.code).toBe('erasure_exists');
    // Changes that do not touch the admin set still work.
    expect((await patch(tech.user.id, 'role', { role: 'senior_technician' })).statusCode).toBe(200);
    expect((await call(t.app, '/api/v1/users/invite', { cookie: a.cookie, body: { email: `tech-${randomUUID()}@example.test`, name: 'New Tech', role: 'technician' } })).statusCode).toBe(201);
    expect((await cancel(a, id)).statusCode).toBe(200);
    expect((await patch(tech.user.id, 'role', { role: 'org_admin' })).statusCode).toBe(200);
    expect((await patch(tech.user.id, 'status', { status: 'disabled' })).statusCode).toBe(200);
    // A disabled admin cannot be re-enabled while a new erasure is open.
    await setRole(b.user.id, 8, null);
    const id2 = (await request(a)).json().erasure.id as string;
    expect((await patch(tech.user.id, 'status', { status: 'active' })).json().error.code).toBe('erasure_exists');
    await cancel(a, id2);
  });
});

describe('who reads what (2.1, 5.6)', () => {
  it('org_admin and auditor read the record; every other role reads the notice only; no names for them', async () => {
    const { a, b } = await twoAdmins();
    const auditor = await addMember(t.app, a, 'auditor');
    const tech = await addMember(t.app, a, 'technician');
    const observer = await addMember(t.app, a, 'observer');
    expect((await status(tech)).json()).toEqual({ notice: null });
    expect((await status(a)).json()).toEqual({ erasure: null });
    const id = (await request(a)).json().erasure.id as string;
    await approve(b, id);
    for (const who of [a, auditor]) {
      const r = erasureStatusReplySchema.parse((await status(who)).json());
      expect('erasure' in r && r.erasure?.id).toBe(id);
    }
    for (const who of [tech, observer]) {
      const r = (await status(who)).json();
      expect(Object.keys(r)).toEqual(['notice']);
      expect(Object.keys(r.notice).sort()).toEqual(['certificateUrl', 'coolingOffUntil', 'state']);
      expect(r.notice.state).toBe('cooling_off');
      expect(JSON.stringify(r)).not.toContain(a.user.name);
    }
    expect((await call(t.app, `/api/v1/orgs/current/erasure/${id}/approve`, { cookie: auditor.cookie, body: { confirmSlug: a.org.slug } })).statusCode).toBe(403);
    expect((await cancel(auditor, id)).statusCode).toBe(403);
    // The public routes answer 404 until completion.
    expect((await call(t.app, `/api/v1/erasures/${id}/certificate`)).statusCode).toBe(404);
    expect((await call(t.app, `/api/v1/erasures/${id}/chain-digest`)).statusCode).toBe(404);
    expect((await call(t.app, '/api/v1/erasures/not-a-uuid/certificate')).statusCode).toBe(404);
    // The latest terminal one stays readable by an admin after a cancel; the notice is gone.
    await cancel(a, id);
    expect((await status(a)).json().erasure.state).toBe('cancelled');
    expect((await status(tech)).json()).toEqual({ notice: null });
  });
});

describe('mails (5.2d)', () => {
  it('every active org_admin and auditor is mailed at request and at approval (smtp only)', async () => {
    const { a, b } = await twoAdmins();
    const auditor = await addMember(t.app, a, 'auditor');
    await addMember(t.app, a, 'technician');
    (t.ctx as { mailer: Mailer }).mailer = fakeSmtp;
    const id = (await request(a)).json().erasure.id as string;
    const recipients = async () => {
      const rows = await t.db.select({ id: user.id, email: user.email }).from(user).where(eq(user.orgId, a.org.id));
      const by = new Map(rows.map((r) => [r.email, r.id]));
      return sent.map((m) => by.get(m.to)).sort();
    };
    expect(await recipients()).toEqual([a.user.id, b.user.id, auditor.user.id].sort());
    expect(sent[0]!.text).toContain(`asked to permanently erase Org `);
    expect(sent[0]!.text).toContain("It needs a second administrator's approval. Any administrator can cancel it at http://localhost:5173/app/settings/erasure.");
    expect(sent[0]!.text).toContain(`/api/v1/erasures/${id}/certificate`);
    sent = [];
    await approve(b, id);
    expect(await recipients()).toEqual([a.user.id, b.user.id, auditor.user.id].sort());
    expect(sent[0]!.text).toMatch(/and Second Admin scheduled the permanent erasure of Org .* on \d+ \w+ \d{4}, \d\d:\d\d UTC\. Any administrator can cancel it before then/);
    expect(sent[0]!.text).toContain(`After it runs, its signed certificate will be at http://localhost:4145/api/v1/erasures/${id}/certificate.`);
    for (const m of sent) expect(m.subject).not.toMatch(/[\r\n]/);
    await cancel(a, id);
  });
});

describe('the single-admin path (5.2f)', () => {
  it('log driver: the link is shown once; confirm needs the requester, a fresh sign-in and the token; 14 days', async () => {
    const a = await signup(t.app);
    const tech = await addMember(t.app, a, 'technician');
    const r = await request(a, { solo: true });
    expect(r.statusCode).toBe(201);
    const { erasure, confirmUrl } = erasureReplySchema.parse(r.json());
    expect(erasure.state).toBe('pending_confirmation');
    expect(confirmUrl).toMatch(/^http:\/\/localhost:5173\/app\/settings\/erasure#confirm=[A-Za-z0-9_-]{43}$/);
    const token = confirmUrl!.split('#confirm=')[1]!;
    // Never shown again.
    expect(JSON.stringify((await status(a)).json())).not.toContain(token);
    const confirm = (who: Account, tok: string) => call(t.app, `/api/v1/orgs/current/erasure/${erasure.id}/confirm`, { cookie: who.cookie, body: { token: tok } });
    expect((await confirm(tech, token)).statusCode).toBe(403);
    expect((await confirm(a, 'A'.repeat(43))).json().error.code).toBe('erasure_confirm_invalid');
    await staleSignIn(a.user.id);
    expect((await confirm(a, token)).json().error.code).toBe('reauth_required');
    await freshSignIn(a.user.id);
    const ok = await confirm(a, token);
    expect(ok.statusCode).toBe(200);
    const until = Date.parse(ok.json().erasure.coolingOffUntil);
    expect(Math.abs(until - (Date.now() + LIMITS.erasureSoloCoolingOffDays * DAY))).toBeLessThan(60_000);
    expect(await chain(a.org.id, 'org.erasure_requested')).toEqual([{ erasureId: erasure.id, solo: true }]);
    expect(await chain(a.org.id, 'org.erasure_confirmed')).toEqual([{ erasureId: erasure.id, coolingOffUntil: ok.json().erasure.coolingOffUntil }]);
    // Single use.
    expect((await confirm(a, token)).json().error.code).toBe('erasure_confirm_invalid');
    // The admin set is frozen: no second admin can be added to change the path.
    expect((await call(t.app, `/api/v1/users/${tech.user.id}/role`, { method: 'PATCH', cookie: a.cookie, body: { role: 'org_admin' } })).json().error.code).toBe('erasure_exists');
    expect((await cancel(a, erasure.id)).json().erasure.state).toBe('cancelled');
  });

  it('smtp: the link is mailed to the admin only, auditors get the notice, the reply carries no link', async () => {
    const a = await signup(t.app);
    const auditor = await addMember(t.app, a, 'auditor');
    (t.ctx as { mailer: Mailer }).mailer = fakeSmtp;
    const r = await request(a, { solo: true });
    expect(r.json().confirmUrl).toBeUndefined();
    const toAdmin = sent.filter((m) => m.text.includes('#confirm='));
    expect(toAdmin).toHaveLength(1);
    const adminRow = (await t.db.select({ email: user.email }).from(user).where(eq(user.id, a.user.id)))[0]!;
    const auditorRow = (await t.db.select({ email: user.email }).from(user).where(eq(user.id, auditor.user.id)))[0]!;
    expect(toAdmin[0]!.to).toBe(adminRow.email);
    const notice = sent.filter((m) => m.to === auditorRow.email);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).not.toContain('#confirm=');
    expect(notice[0]!.text).toContain('as its only administrator');
    await cancel(a, r.json().erasure.id);
  });

  it('is refused when an eligible approver exists, and after a recent demotion of an admin', async () => {
    const { a, b } = await twoAdmins();
    expect((await request(a, { solo: true })).json().error.code).toBe('bad_state');
    expect((await call(t.app, `/api/v1/users/${b.user.id}/role`, { method: 'PATCH', cookie: a.cookie, body: { role: 'technician' } })).statusCode).toBe(200);
    const solo = await request(a, { solo: true });
    expect(solo.json().error).toMatchObject({ code: 'erasure_second_admin', details: { soloAvailable: false } });
    expect((await request(a)).json().error).toMatchObject({ code: 'erasure_second_admin', details: { soloAvailable: false } });
  });
});

describe('rate limits (2.3)', () => {
  let rl: TestApp;
  beforeAll(async () => {
    rl = await makeApp({ RATE_LIMIT_DISABLED: 'false' });
  });
  afterAll(async () => {
    await rl?.close();
  });

  it('request and approve have 5 / hour buckets per org; Cancel still succeeds when both are exhausted', async () => {
    const a = await signup(rl.app);
    const b = await addMember(rl.app, a, 'org_admin', 'Second Admin');
    await rl.db.update(user).set({ roleSince: new Date(Date.now() - 8 * DAY), roleGrantedBy: null }).where(eq(user.id, b.user.id));
    const req = () => call(rl.app, '/api/v1/orgs/current/erasure', { cookie: a.cookie, body: { confirmSlug: 'wrong-slug' } });
    for (let i = 0; i < 5; i++) expect((await req()).statusCode).toBe(400);
    expect((await req()).statusCode).toBe(429);
    await rl.ctx.limiter.reset(`erasure-request:${a.org.id}`);
    const id = (await call(rl.app, '/api/v1/orgs/current/erasure', { cookie: a.cookie, body: { confirmSlug: a.org.slug } })).json().erasure.id as string;
    for (let i = 0; i < 4; i++) await req();
    expect((await req()).statusCode).toBe(429);
    const app_ = () => call(rl.app, `/api/v1/orgs/current/erasure/${id}/approve`, { cookie: b.cookie, body: { confirmSlug: 'wrong-slug' } });
    for (let i = 0; i < 5; i++) expect((await app_()).statusCode).toBe(400);
    expect((await app_()).statusCode).toBe(429);
    const c = await call(rl.app, `/api/v1/orgs/current/erasure/${id}/cancel`, { cookie: b.cookie, body: {} });
    expect(c.statusCode).toBe(200);
    expect(c.json().erasure.state).toBe('cancelled');
  });
});
