/**
 * Phase E section 15.3, the push lifecycle (rules 4.4a-4.4g) through `POST /integrations/:type/ticket` against the
 * in-process fake Jira: delivery and its chain entries, the failure classification and the retry rule (ambiguous
 * non-webhook failures never auto-retried), the schedule through the sweeper with a fake clock, Retry-After honoured
 * and capped, the attempt limit, manual retry and its limit, clientPushId idempotency and conflicts, the request
 * refusals, and delete or disable failing in-flight pushes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJsonBytes, LIMITS, sha256Hex, ticketContentSchema, ticketPushSchema, type TicketPush } from '@indiansassist/shared';
import { getTicketPush, listAuditBySession, ticketPush } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { attemptTiming } from '../src/integrations/adapter.js';
import { sweepTicketPushes } from '../src/integrations/sweep.js';
import { addMember, call, signup, type Account, type TestApp } from './helpers.js';
import { FakeTicketing, jiraRoutes, refusedUrl } from './fake-ticketing.js';
import { configureJira, endedSession, insertSummary, makeTicketApp, manualPush, SUMMARY_OUTPUT } from './tickets-kit.js';

let t: TestApp;
let f: FakeTicketing;
let admin: Account;
let tech: Account;
let senior: Account;
let auditor: Account;

beforeAll(async () => {
  t = await makeTicketApp();
  f = await FakeTicketing.start();
  admin = await signup(t.app);
  tech = await addMember(t.app, admin, 'technician', 'Asha R');
  senior = await addMember(t.app, admin, 'senior_technician');
  auditor = await addMember(t.app, admin, 'auditor');
  await configureJira(t, admin, f.url);
});
afterAll(async () => {
  await f.close();
  await t.close();
});
beforeEach(() => {
  f.reset();
  jiraRoutes(f);
});
afterEach(() => {
  attemptTiming.timeoutMs = 15_000;
});

async function push(acc: Account, body: Record<string, unknown>, type = 'jira') {
  return call(t.app, `/api/v1/integrations/${type}/ticket`, { cookie: acc.cookie, body });
}

async function pushOk(acc: Account, body: Record<string, unknown>): Promise<TicketPush> {
  const r = await push(acc, body);
  expect(r.statusCode, r.body).toBe(201);
  const p = (r.json() as { push: TicketPush }).push;
  expect(ticketPushSchema.safeParse(p).success).toBe(true);
  return p;
}

const chain = async (sessionId: string) => (await listAuditBySession(t.db, sessionId)).map((e) => [e.action, e.actorType, e.data] as const);

describe('delivery (rules 4.4a, 4.4b)', () => {
  it('a manual note is pushed synchronously, stored exactly, chained requested then delivered', async () => {
    const sid = await endedSession(t, tech);
    const p = await pushOk(tech, manualPush(sid, { title: 'Printer', priority: 'high' }));
    expect(p).toMatchObject({ state: 'delivered', attempts: 1, manualRetries: 0, externalId: 'OPS-42', externalUrl: `${f.url}/browse/OPS-42`, source: 'manual', summary: null, lastFailure: null });
    expect(p.createdBy).toEqual({ id: tech.user.id, name: 'Asha R' });
    expect(JSON.stringify(p)).not.toContain('Called the user back');
    const row = (await getTicketPush(t.db, tech.org.id, p.id))!;
    const content = ticketContentSchema.parse(row.content);
    expect(content).toMatchObject({ title: 'Printer', source: 'manual', priority: 'high', requesterEmail: null, summary: null });
    expect(content.session).toMatchObject({ id: sid, url: `http://localhost:5173/app/sessions/${sid}`, tier: 'p1_browser', technician: 'Asha R', chainVerified: null });
    expect(content.body.startsWith('Called the user back; all fine.\n\n—\nRemote session: ')).toBe(true);
    expect(p.contentSha256).toBe(sha256Hex(canonicalJsonBytes(content)));
    // The body was sent to Jira as ADF.
    expect(f.last().path).toBe('/rest/api/3/issue');
    expect(JSON.stringify(f.last().json)).toContain('Called the user back; all fine.');
    expect(await chain(sid)).toEqual([
      ['ticket.push_requested', 'user', { pushId: p.id, type: 'jira', mode: 'create', source: 'manual', summaryVersion: null, contentSha256: p.contentSha256 }],
      ['ticket.push_delivered', 'system', { pushId: p.id, type: 'jira', externalId: 'OPS-42', attempts: 1 }],
    ]);
    // GET /sessions/:id/tickets (newest first), readable by an auditor, not by an observer.
    const second = await pushOk(tech, manualPush(sid, { mode: 'append', externalId: 'OPS-42' }));
    expect(f.last().path).toBe('/rest/api/3/issue/OPS-42/comment');
    const list = await call(t.app, `/api/v1/sessions/${sid}/tickets`, { cookie: auditor.cookie });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: TicketPush[] }).items.map((x) => x.id)).toEqual([second.id, p.id]);
    expect(list.body).not.toContain('Called the user back');
    const observer = await addMember(t.app, admin, 'observer');
    expect((await call(t.app, `/api/v1/sessions/${sid}/tickets`, { cookie: observer.cookie })).statusCode).toBe(403);
  });

  it('a summary push uses the latest ready version by default, or the named one', async () => {
    const sid = await endedSession(t, tech);
    expect((await push(tech, { sessionId: sid, clientPushId: randomUUID(), mode: 'create', source: 'summary' })).json()).toMatchObject({ error: { code: 'summary_not_ready' } });
    const v1 = await insertSummary(t, tech.org.id, sid, 1);
    const v2 = await insertSummary(t, tech.org.id, sid, 2, 'ready', { ...SUMMARY_OUTPUT, ticketNote: 'Version two note.', followUps: [] });
    await insertSummary(t, tech.org.id, sid, 3, 'pending');
    const latest = await pushOk(tech, { sessionId: sid, clientPushId: randomUUID(), mode: 'create', source: 'summary' });
    expect(latest.summary).toEqual({ version: 2, sha256: v2.sha256 });
    const row = (await getTicketPush(t.db, tech.org.id, latest.id))!;
    expect(ticketContentSchema.parse(row.content).body).toMatch(/^Version two note\.\n\nActions taken:\n- Cleared the print queue\n- Restarted the spooler service\n\n—\n/);
    const named = await pushOk(tech, { sessionId: sid, clientPushId: randomUUID(), mode: 'create', source: 'summary', summaryVersion: 1 });
    expect(named.summary).toEqual({ version: 1, sha256: v1.sha256 });
    expect((await chain(sid)).find(([a, , d]) => a === 'ticket.push_requested' && (d as { pushId: string }).pushId === named.id)?.[2]).toMatchObject({ summaryVersion: 1, source: 'summary' });
    const pending = await push(tech, { sessionId: sid, clientPushId: randomUUID(), mode: 'create', source: 'summary', summaryVersion: 3 });
    expect([pending.statusCode, pending.json().error.code]).toEqual([409, 'summary_not_ready']);
    const missing = await push(tech, { sessionId: sid, clientPushId: randomUUID(), mode: 'create', source: 'summary', summaryVersion: 9 });
    expect([missing.statusCode, missing.json().error.code]).toEqual([409, 'summary_not_ready']);
  });

  it('requesterEmail is sent only when typed in the dialog', async () => {
    const sid = await endedSession(t, tech);
    const p = await pushOk(tech, manualPush(sid, { requesterEmail: 'user@customer.example.test' }));
    expect(ticketContentSchema.parse((await getTicketPush(t.db, tech.org.id, p.id))!.content).requesterEmail).toBe('user@customer.example.test');
  });
});

describe('refusals (section 4.7)', () => {
  it('validation, roles, scope, state, configuration', async () => {
    const sid = await endedSession(t, tech);
    expect((await push(tech, { sessionId: sid, clientPushId: randomUUID(), mode: 'append', source: 'manual', note: 'x' })).json().error.code).toBe('validation_failed');
    expect((await push(tech, manualPush(sid), 'nope')).statusCode).toBe(404);
    expect((await push(auditor, manualPush(sid))).statusCode).toBe(403);
    const other = await addMember(t.app, admin, 'technician');
    expect((await push(other, manualPush(sid))).statusCode).toBe(403);
    expect((await push(senior, manualPush(sid))).statusCode).toBe(201);
    const stranger = await signup(t.app);
    expect((await push(stranger, manualPush(sid))).statusCode).toBe(404);
    const live = await endedSession(t, tech, { state: 'active' });
    expect((await push(tech, manualPush(live))).json().error.code).toBe('session_not_ended');
    expect((await push(tech, manualPush(sid), 'servicenow')).json().error.code).toBe('integration_not_configured');
    expect((await push(tech, manualPush(randomUUID()))).statusCode).toBe(404);
  });

  it('a disabled integration refuses pushes; available lists enabled ones only', async () => {
    const other = await signup(t.app);
    const sid = await endedSession(t, other);
    await configureJira(t, other, f.url, false);
    expect((await push(other, manualPush(sid))).json().error).toMatchObject({ code: 'integration_disabled' });
    const avail = await call(t.app, '/api/v1/integrations/available', { cookie: other.cookie });
    expect(avail.json()).toEqual({ items: [] });
    expect((await call(t.app, '/api/v1/integrations/available', { cookie: tech.cookie })).json()).toEqual({ items: [{ type: 'jira', enabled: true }] });
  });
});

describe('idempotency (rule 4.4f)', () => {
  it('the same clientPushId, session, type and mode returns the push unchanged; another session conflicts', async () => {
    const sid = await endedSession(t, tech);
    const body = manualPush(sid);
    const first = await pushOk(tech, body);
    const again = await push(tech, body);
    expect(again.statusCode).toBe(200);
    expect((again.json() as { push: TicketPush }).push).toEqual(first);
    expect(f.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    const sid2 = await endedSession(t, tech);
    const conflict = await push(tech, { ...body, sessionId: sid2 });
    expect([conflict.statusCode, conflict.json().error.code]).toEqual([409, 'push_id_conflict']);
    expect((await push(tech, { ...body, mode: 'append', externalId: 'OPS-1' })).json().error.code).toBe('push_id_conflict');
    expect((await chain(sid)).filter(([a]) => a === 'ticket.push_requested')).toHaveLength(1);
  });
});

describe('failures and the retry rule (rules 4.4c, 4.4d)', () => {
  it.each([
    ['500', { status: 500 }, 'upstream_error', 500],
    ['422', { status: 422, json: { errors: { summary: 'bad' } } }, 'validation', 422],
    ['401', { status: 401 }, 'auth', 401],
  ] as const)('%s fails at once, chained with willRetry false', async (_n, scripted, cause, status) => {
    const sid = await endedSession(t, tech);
    f.script(scripted);
    const p = await pushOk(tech, manualPush(sid));
    expect(p).toMatchObject({ state: 'failed', attempts: 1, nextAttemptAt: null, lastFailure: { cause, status, sent: true } });
    expect((await chain(sid)).at(-1)).toEqual(['ticket.push_failed', 'system', { pushId: p.id, type: 'jira', cause, status, attempt: 1, willRetry: false }]);
  });

  it('a hung upstream is an ambiguous timeout: failed, never retried automatically', async () => {
    attemptTiming.timeoutMs = 400;
    const sid = await endedSession(t, tech);
    f.script({ hang: true });
    const p = await pushOk(tech, manualPush(sid));
    expect(p).toMatchObject({ state: 'failed', lastFailure: { cause: 'timeout', status: null, sent: true } });
  });

  it('a reset after the request is ambiguous too; a refused connection was never sent and is retried', async () => {
    const sid = await endedSession(t, tech);
    f.script({ reset: true });
    expect(await pushOk(tech, manualPush(sid))).toMatchObject({ state: 'failed', lastFailure: { cause: 'upstream_error', status: null, sent: true } });
    const other = await signup(t.app);
    const osid = await endedSession(t, other);
    await configureJira(t, other, await refusedUrl());
    const p = await pushOk(other, manualPush(osid));
    expect(p).toMatchObject({ state: 'retrying', lastFailure: { cause: 'unreachable', sent: false } });
    expect(Date.parse(p.nextAttemptAt!) - Date.now()).toBeGreaterThan(25_000);
  });

  it('429 with Retry-After is retried after the larger of the schedule and Retry-After, capped at 2 h', async () => {
    const sid = await endedSession(t, tech);
    const before = Date.now();
    f.script({ status: 429, headers: { 'retry-after': '90' } });
    const p = await pushOk(tech, manualPush(sid));
    expect(p).toMatchObject({ state: 'retrying', attempts: 1, lastFailure: { cause: 'rate_limited', status: 429, retryAfterSec: 90 } });
    const wait = Date.parse(p.nextAttemptAt!) - before;
    expect(wait).toBeGreaterThanOrEqual(89_000);
    expect(wait).toBeLessThan(95_000);
    expect((await chain(sid)).at(-1)?.[2]).toMatchObject({ cause: 'rate_limited', status: 429, willRetry: true });
    f.script({ status: 429, headers: { 'retry-after': '86400' } });
    const capped = await pushOk(tech, manualPush(sid));
    expect(Date.parse(capped.nextAttemptAt!) - Date.now()).toBeLessThanOrEqual(7200_000);
    expect(Date.parse(capped.nextAttemptAt!) - Date.now()).toBeGreaterThan(7100_000);
  });

  it('the sweeper runs due attempts on the 30 s, 2 min, 10 min, 30 min, 2 h schedule and fails after 6', async () => {
    const sid = await endedSession(t, tech);
    f.script({ status: 503 });
    const p = await pushOk(tech, manualPush(sid));
    expect(p.state).toBe('retrying');
    let row = (await getTicketPush(t.db, tech.org.id, p.id))!;
    const waits: number[] = [];
    let last = row.updatedAt.getTime();
    for (let attempt = 2; attempt <= LIMITS.ticketPushMaxAttempts; attempt++) {
      const due = row.nextAttemptAt!;
      waits.push(Math.round((due.getTime() - last) / 1000));
      // Not yet due: nothing happens.
      await sweepTicketPushes(t.ctx, new Date(due.getTime() - 1000));
      expect((await getTicketPush(t.db, tech.org.id, p.id))!.attempts).toBe(attempt - 1);
      f.script({ status: 503 });
      await sweepTicketPushes(t.ctx, due);
      row = (await getTicketPush(t.db, tech.org.id, p.id))!;
      expect(row.attempts).toBe(attempt);
      last = due.getTime();
    }
    expect(waits).toEqual([30, 120, 600, 1800, 7200]);
    expect(row.state).toBe('failed');
    expect(row.nextAttemptAt).toBeNull();
    const fails = (await chain(sid)).filter(([a, , d]) => a === 'ticket.push_failed' && (d as { pushId: string }).pushId === p.id);
    expect(fails.map(([, , d]) => [(d as { attempt: number }).attempt, (d as { willRetry: boolean }).willRetry])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
      [6, false],
    ]);
  });

  it('a retried push that then succeeds is delivered with its attempt count', async () => {
    const sid = await endedSession(t, tech);
    f.script({ status: 503 });
    const p = await pushOk(tech, manualPush(sid));
    const due = (await getTicketPush(t.db, tech.org.id, p.id))!.nextAttemptAt!;
    await sweepTicketPushes(t.ctx, due);
    expect((await getTicketPush(t.db, tech.org.id, p.id))!).toMatchObject({ state: 'delivered', attempts: 2, externalId: 'OPS-42', lastFailure: null });
    expect((await chain(sid)).at(-1)).toEqual(['ticket.push_delivered', 'system', { pushId: p.id, type: 'jira', externalId: 'OPS-42', attempts: 2 }]);
  });
});

describe('manual retry (rule 4.4e)', () => {
  it('retries a failed push, chained before the outcome, at most three times', async () => {
    const sid = await endedSession(t, tech);
    f.script({ status: 500 });
    const p = await pushOk(tech, manualPush(sid));
    const retry = (acc: Account) => call(t.app, `/api/v1/integrations/pushes/${p.id}/retry`, { cookie: acc.cookie, body: {} });
    const other = await addMember(t.app, admin, 'technician');
    expect((await retry(other)).statusCode).toBe(403);
    expect((await retry(auditor)).statusCode).toBe(403);
    for (let i = 1; i <= LIMITS.ticketPushManualRetries; i++) {
      f.script({ status: 500 });
      const r = await retry(i === 2 ? senior : tech);
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as { push: TicketPush }).push).toMatchObject({ state: 'failed', manualRetries: i, attempts: i + 1 });
    }
    const limit = await retry(admin);
    expect([limit.statusCode, limit.json().error.code]).toEqual([409, 'retry_limit']);
    const entries = (await chain(sid)).map(([a, actor]) => `${a}:${actor}`);
    expect(entries).toEqual([
      'ticket.push_requested:user',
      'ticket.push_failed:system',
      'ticket.push_retried:user',
      'ticket.push_failed:system',
      'ticket.push_retried:user',
      'ticket.push_failed:system',
      'ticket.push_retried:user',
      'ticket.push_failed:system',
    ]);
  });

  it('only a failed push can be retried; a disabled integration refuses', async () => {
    const sid = await endedSession(t, tech);
    const ok = await pushOk(tech, manualPush(sid));
    const r = await call(t.app, `/api/v1/integrations/pushes/${ok.id}/retry`, { cookie: tech.cookie, body: {} });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'bad_state']);
    expect((await call(t.app, `/api/v1/integrations/pushes/${randomUUID()}/retry`, { cookie: tech.cookie, body: {} })).statusCode).toBe(404);
    const other = await signup(t.app);
    const osid = await endedSession(t, other);
    await configureJira(t, other, f.url);
    f.script({ status: 500 });
    const failed = await pushOk(other, manualPush(osid));
    await configureJira(t, other, f.url, false);
    const refused = await call(t.app, `/api/v1/integrations/pushes/${failed.id}/retry`, { cookie: other.cookie, body: {} });
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'integration_disabled']);
    // Cross-org ids are 404.
    expect((await call(t.app, `/api/v1/integrations/pushes/${failed.id}/retry`, { cookie: admin.cookie, body: {} })).statusCode).toBe(404);
  });
});

describe('delete or disable fails in-flight pushes (rule 4.4g)', () => {
  it.each(['disable', 'delete'] as const)('%s', async (how) => {
    const other = await signup(t.app);
    const sid = await endedSession(t, other);
    await configureJira(t, other, f.url);
    f.script({ status: 503 });
    const p = await pushOk(other, manualPush(sid));
    expect(p.state).toBe('retrying');
    const r =
      how === 'disable'
        ? await call(t.app, '/api/v1/integrations/jira', { method: 'PUT', cookie: other.cookie, body: { enabled: false, config: { siteUrl: f.url, deployment: 'cloud', projectKey: 'OPS' } } })
        : await call(t.app, '/api/v1/integrations/jira', { method: 'DELETE', cookie: other.cookie });
    expect(r.statusCode, r.body).toBe(how === 'disable' ? 200 : 204);
    const row = (await getTicketPush(t.db, other.org.id, p.id))!;
    expect(row).toMatchObject({ state: 'failed', nextAttemptAt: null, lastFailure: { cause: 'misconfigured', sent: false } });
    expect((await chain(sid)).at(-1)).toEqual(['ticket.push_failed', 'system', { pushId: p.id, type: 'jira', cause: 'misconfigured', status: null, attempt: 1, willRetry: false }]);
    // The sweeper has nothing left to run for it.
    await sweepTicketPushes(t.ctx, new Date(Date.now() + 86_400_000));
    expect((await getTicketPush(t.db, other.org.id, p.id))!.attempts).toBe(1);
    if (how === 'delete') {
      expect((await call(t.app, '/api/v1/integrations/jira', { cookie: other.cookie })).statusCode).toBe(404);
      // The push history stays readable.
      expect((await call(t.app, `/api/v1/sessions/${sid}/tickets`, { cookie: other.cookie })).json().items).toHaveLength(1);
      expect((await t.db.select().from(ticketPush).where(eq(ticketPush.id, p.id))).length).toBe(1);
    }
  });
});
