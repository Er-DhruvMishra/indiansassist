/**
 * Phase E section 15.3, the signed webhook (section 4.5) against an in-process receiver: the secret minted by the
 * server and shown once, the headers and canonical body, the signature verified with the receiver-side function (key =
 * the decoded 32 bytes), a stable push id with a fresh timestamp and signature on every attempt, the second `v1=`
 * signature during the 24 h rotation overlap and not after, the URL path and query sealed and never returned, retries
 * on 5xx and timeout, the receiver's externalId recorded, and the ping test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJson, utf8Encode, verifyWebhookSignature, webhookSignature, type Integration, type TicketPush } from '@indiansassist/shared';
import { getIntegration, getTicketPush, ticketPush } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { attemptTiming } from '../src/integrations/adapter.js';
import { sweepTicketPushes } from '../src/integrations/sweep.js';
import { call, signup, type Account, type TestApp } from './helpers.js';
import { FakeTicketing, webhookRoutes, type Recorded } from './fake-ticketing.js';
import { configureWebhook, endedSession, makeTicketApp, manualPush } from './tickets-kit.js';

let t: TestApp;
let f: FakeTicketing;

beforeAll(async () => {
  t = await makeTicketApp();
  f = await FakeTicketing.start();
});
afterAll(async () => {
  await f.close();
  await t.close();
});
beforeEach(() => {
  f.reset();
  webhookRoutes(f);
});
afterEach(() => {
  attemptTiming.timeoutMs = 15_000;
});

const hookUrl = () => `${f.url}/hooks/T000/B000/XXXXsecretpath?token=query-secret-123`;

async function setup(): Promise<{ admin: Account; secret: string; sid: string }> {
  const admin = await signup(t.app);
  const secret = await configureWebhook(t, admin, hookUrl());
  const sid = await endedSession(t, admin);
  return { admin, secret, sid };
}

function header(r: Recorded, name: string): string {
  const v = r.headers[name.toLowerCase()];
  return Array.isArray(v) ? v.join(',') : (v ?? '');
}

async function pushOk(acc: Account, body: Record<string, unknown>): Promise<TicketPush> {
  const r = await call(t.app, '/api/v1/integrations/webhook/ticket', { cookie: acc.cookie, body });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { push: TicketPush }).push;
}

describe('configuration', () => {
  it('mints the secret once, seals the URL path and query, and returns only the origin', async () => {
    const admin = await signup(t.app);
    const created = await call(t.app, '/api/v1/integrations/webhook', { method: 'PUT', cookie: admin.cookie, body: { enabled: true, config: { url: hookUrl() }, credentials: { secret: 'mine' } } });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { integration: Integration; secret: string };
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.integration.config).toEqual({ origin: f.url, pathSet: true });
    expect(body.integration.credentials).toMatchObject({ set: true, fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(created.body).not.toContain('secretpath');
    expect(created.body).not.toContain('query-secret-123');
    const row = (await getIntegration(t.db, admin.org.id, 'webhook'))!;
    expect(row.config).toEqual({ origin: f.url, pathSet: true });
    expect(row.credentialsEnc).not.toContain('secretpath');
    expect(row.credentialsEnc).not.toContain(body.secret);
    // A second save keeps the secret and does not show it again.
    const again = await call(t.app, '/api/v1/integrations/webhook', { method: 'PUT', cookie: admin.cookie, body: { enabled: true, config: { url: `${f.url}/other` } } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).not.toHaveProperty('secret');
    const read = await call(t.app, '/api/v1/integrations/webhook', { cookie: admin.cookie });
    expect(read.json().config).toEqual({ origin: f.url, pathSet: true });
    expect(read.body).not.toContain('/other');
    const bare = await call(t.app, '/api/v1/integrations/webhook', { method: 'PUT', cookie: admin.cookie, body: { enabled: true, config: { url: f.url } } });
    expect(bare.json().config).toEqual({ origin: f.url, pathSet: false });
  });

  it('a ping test is signed and answers ok', async () => {
    const { admin, secret } = await setup();
    const r = await call(t.app, '/api/v1/integrations/webhook/test', { cookie: admin.cookie, body: {} });
    expect(r.json()).toEqual({ ok: true, cause: null, detail: null, account: null });
    const req = f.last();
    expect(req.path).toBe('/hooks/T000/B000/XXXXsecretpath');
    expect(req.query.get('token')).toBe('query-secret-123');
    expect(header(req, 'x-ia-event')).toBe('ping');
    expect(header(req, 'x-ia-push-id')).toBe('');
    const json = req.json as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['event', 'orgId', 'sentAt', 'v']);
    expect(json).toMatchObject({ v: 1, event: 'ping', orgId: admin.org.id });
    const ts = Number(header(req, 'x-ia-timestamp'));
    expect(verifyWebhookSignature([secret], header(req, 'x-ia-signature'), ts, utf8Encode(req.raw), new Date())).toBe(true);
  });
});

describe('delivery (section 4.5)', () => {
  it('sends the canonical body with the binding headers, verifiable by the receiver; records the receiver ids', async () => {
    const { admin, secret, sid } = await setup();
    const p = await pushOk(admin, manualPush(sid));
    expect(p).toMatchObject({ state: 'delivered', externalId: 'HOOK-1', externalUrl: 'https://tickets.example.test/HOOK-1' });
    const req = f.last();
    expect(req.method).toBe('POST');
    expect(header(req, 'content-type')).toBe('application/json');
    expect(header(req, 'user-agent')).toBe('IndiansAssist-Webhook/1');
    expect(header(req, 'x-ia-event')).toBe('ticket.push');
    expect(header(req, 'x-ia-push-id')).toBe(p.id);
    expect(header(req, 'x-ia-attempt')).toBe('1');
    const ts = Number(header(req, 'x-ia-timestamp'));
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
    const sig = header(req, 'x-ia-signature');
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(sig).toBe(webhookSignature(secret, ts, utf8Encode(req.raw)));
    expect(verifyWebhookSignature([secret], sig, ts, utf8Encode(req.raw), new Date())).toBe(true);
    const body = req.json as Record<string, unknown>;
    expect(req.raw).toBe(canonicalJson(body));
    expect(Object.keys(body).sort()).toEqual(['event', 'externalId', 'mode', 'orgId', 'pushId', 'sentAt', 'ticket', 'v']);
    expect(body).toMatchObject({ v: 1, event: 'ticket.push', pushId: p.id, orgId: admin.org.id, mode: 'create', externalId: null });
    expect((body['ticket'] as { source: string }).source).toBe('manual');
    // Append carries the external id.
    await pushOk(admin, manualPush(sid, { mode: 'append', externalId: 'HOOK-1' }));
    expect(f.last().json).toMatchObject({ mode: 'append', externalId: 'HOOK-1' });
  });

  it('a receiver that names no id leaves externalId null', async () => {
    const { admin, sid } = await setup();
    f.script({ status: 204 });
    const p = await pushOk(admin, manualPush(sid));
    expect(p).toMatchObject({ state: 'delivered', externalId: null, externalUrl: null });
  });

  it('5xx and timeouts are retried (receivers de-duplicate); every attempt has the same push id and a fresh timestamp and signature', async () => {
    const { admin, secret, sid } = await setup();
    f.script({ status: 500 });
    const p = await pushOk(admin, manualPush(sid));
    expect(p).toMatchObject({ state: 'retrying', lastFailure: { cause: 'upstream_error', status: 500 } });
    const first = f.last();
    attemptTiming.timeoutMs = 400;
    f.script({ hang: true });
    const due = (await getTicketPush(t.db, admin.org.id, p.id))!.nextAttemptAt!;
    await sweepTicketPushes(t.ctx, due);
    const second = f.last();
    expect((await getTicketPush(t.db, admin.org.id, p.id))!).toMatchObject({ state: 'retrying', attempts: 2, lastFailure: { cause: 'timeout' } });
    attemptTiming.timeoutMs = 15_000;
    const due2 = (await getTicketPush(t.db, admin.org.id, p.id))!.nextAttemptAt!;
    await sweepTicketPushes(t.ctx, due2);
    const third = f.last();
    expect((await getTicketPush(t.db, admin.org.id, p.id))!).toMatchObject({ state: 'delivered', attempts: 3 });
    expect([first, second, third].map((r) => header(r, 'x-ia-push-id'))).toEqual([p.id, p.id, p.id]);
    expect([first, second, third].map((r) => header(r, 'x-ia-attempt'))).toEqual(['1', '2', '3']);
    const stamps = [first, second, third].map((r) => Number(header(r, 'x-ia-timestamp')));
    expect(new Set(stamps).size).toBe(3);
    expect(new Set([first, second, third].map((r) => header(r, 'x-ia-signature'))).size).toBe(3);
    expect(new Set([first, second, third].map((r) => (r.json as { sentAt: string }).sentAt)).size).toBe(3);
    // Each attempt verifies at its own time.
    for (const r of [first, second, third]) {
      const ts = Number(header(r, 'x-ia-timestamp'));
      expect(verifyWebhookSignature([secret], header(r, 'x-ia-signature'), ts, utf8Encode(r.raw), new Date(ts * 1000))).toBe(true);
    }
  });

  it('after a rotation the previous secret signs as a second v1= for 24 h, and not after', async () => {
    const { admin, secret: oldSecret, sid } = await setup();
    const rot = await call(t.app, '/api/v1/integrations/webhook/rotate-secret', { cookie: admin.cookie, body: {} });
    expect(rot.statusCode).toBe(200);
    const newSecret = (rot.json() as { secret: string }).secret;
    expect(newSecret).not.toBe(oldSecret);
    f.script({ status: 503 });
    const p = await pushOk(admin, manualPush(sid));
    const during = f.last();
    const sig = header(during, 'x-ia-signature');
    expect(sig.split(', ')).toHaveLength(2);
    const ts = Number(header(during, 'x-ia-timestamp'));
    const raw = utf8Encode(during.raw);
    expect(sig).toBe(`${webhookSignature(newSecret, ts, raw)}, ${webhookSignature(oldSecret, ts, raw)}`);
    expect(verifyWebhookSignature([oldSecret], sig, ts, raw, new Date())).toBe(true);
    expect(verifyWebhookSignature([newSecret], sig, ts, raw, new Date())).toBe(true);
    // A retry 25 hours later carries the new signature only.
    const later = new Date(Date.now() + 25 * 3_600_000);
    await t.db.update(ticketPush).set({ nextAttemptAt: later }).where(eq(ticketPush.id, p.id));
    await sweepTicketPushes(t.ctx, later);
    const after = f.last();
    expect(header(after, 'x-ia-signature')).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature([oldSecret], header(after, 'x-ia-signature'), Number(header(after, 'x-ia-timestamp')), utf8Encode(after.raw), later)).toBe(false);
    expect(verifyWebhookSignature([newSecret], header(after, 'x-ia-signature'), Number(header(after, 'x-ia-timestamp')), utf8Encode(after.raw), later)).toBe(true);
    // The audit chain names the rotation, never a secret.
    const audit = await call(t.app, '/api/v1/audit?action=integration.secret_rotated', { cookie: admin.cookie });
    expect(audit.body).not.toContain(newSecret);
    expect(audit.body).not.toContain(oldSecret);
  });

  it('rotation needs a configured webhook', async () => {
    const admin = await signup(t.app);
    const r = await call(t.app, '/api/v1/integrations/webhook/rotate-secret', { cookie: admin.cookie, body: {} });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'integration_not_configured']);
  });
});
