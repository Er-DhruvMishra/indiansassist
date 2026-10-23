/** Phase B recordings (sections 4.7, 10.5, 11.3, Y26, Y27): rrweb mime, inline streaming, delete, retention. */
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getOrg, getRecording, getUser, recording, seedSession, seedToken, transitionSession } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { Sweeper } from '../src/sweeper.js';
import { addMember, call, makeApp, signup, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;

beforeAll(async () => {
  t = await makeApp();
  admin = await signup(t.app);
});
afterAll(async () => {
  await t.close();
});

async function activeP2(owner: Account): Promise<string> {
  const org = (await getOrg(t.db, owner.org.id))!;
  const user = (await getUser(t.db, owner.user.id))!;
  const tok = await seedToken(t.db, org, user, { tier: 'p2_extension', typ: 'timed' });
  const s = await seedSession(t.db, tok, { assistUserId: user.id });
  await transitionSession(t.db, s.id, 'accepted', { set: { assistUserId: user.id } });
  await transitionSession(t.db, s.id, 'consent_pending');
  await transitionSession(t.db, s.id, 'active', { set: { consentSurface: 'browser', consentLevel: 'view', consentScope: 'current_tab', consentBackstage: false } });
  return s.id;
}

async function uploadRrweb(acc: Account, sessionId: string, mime = 'application/x-ia-rrweb+jsonl') {
  const file = gzipSync(Buffer.from(`{"ia_rrweb":1,"sessionId":"${sessionId}"}\n{"tabId":1,"seq":0,"rx":1,"e":{}}\n`));
  const b = `----ia${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify({ mime })}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="rec.jsonl.gz"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const res = await call(t.app, `/api/v1/sessions/${sessionId}/recordings`, { cookie: acc.cookie, body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } });
  return { res, file };
}

describe('rrweb mirror recordings', () => {
  it('accepts the rrweb mime (no codecs), keys it .jsonl.gz and serves it as octet-stream', async () => {
    const sid = await activeP2(admin);
    expect((await uploadRrweb(admin, sid, 'application/x-ia-rrweb+jsonl; codecs=x')).res.statusCode).toBe(400);
    const { res, file } = await uploadRrweb(admin, sid);
    expect(res.statusCode).toBe(201);
    const rec = res.json();
    expect(rec.storageKey.endsWith(`${rec.id}.jsonl.gz`)).toBe(true);
    expect(rec.deletedAt).toBeNull();
    const dl = await call(t.app, `/api/v1/recordings/${rec.id}/download`, { cookie: admin.cookie });
    expect(dl.statusCode).toBe(200);
    const url = new URL(dl.json().url);
    const file1 = await call(t.app, url.pathname + url.search);
    expect(file1.headers['content-type']).toBe('application/octet-stream');
    expect(file1.headers['content-disposition']).toBe(`attachment; filename="${rec.id}.jsonl.gz"`);
    const inline = await call(t.app, `/api/v1/recordings/${rec.id}/download?inline=1`, { cookie: admin.cookie });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers['content-type']).toBe('application/octet-stream');
    expect(inline.headers['cache-control']).toBe('private, no-store');
    expect(inline.headers['x-content-type-options']).toBe('nosniff');
    expect(inline.rawPayload.equals(file)).toBe(true);
  });

  it('DELETE removes the object, keeps the row, chains recording.deleted; verify and download answer 410', async () => {
    const sid = await activeP2(admin);
    const rec = (await uploadRrweb(admin, sid)).res.json();
    const tech = await addMember(t.app, admin, 'technician');
    expect((await call(t.app, `/api/v1/recordings/${rec.id}`, { method: 'DELETE', cookie: tech.cookie })).statusCode).toBe(403);
    const del = await call(t.app, `/api/v1/recordings/${rec.id}`, { method: 'DELETE', cookie: admin.cookie });
    expect(del.statusCode).toBe(204);
    expect(await t.ctx.storage.head(rec.storageKey)).toBeNull();
    const row = await getRecording(t.db, rec.id);
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(row?.deletedBy).toBe(admin.user.id);
    for (const [method, path] of [
      ['DELETE', `/api/v1/recordings/${rec.id}`],
      ['POST', `/api/v1/recordings/${rec.id}/verify`],
      ['GET', `/api/v1/recordings/${rec.id}/download`],
    ] as const) {
      const r = await call(t.app, path, { method, cookie: admin.cookie, ...(method === 'POST' ? { body: {} } : {}) });
      expect(r.statusCode, path).toBe(410);
      expect(r.json().error.code).toBe('recording_deleted');
    }
    const audit = (await call(t.app, `/api/v1/sessions/${sid}/audit`, { cookie: admin.cookie })).json();
    const entry = audit.items.find((e: { action: string }) => e.action === 'recording.deleted');
    expect(entry).toMatchObject({ actor: { type: 'user' }, data: { recordingId: rec.id, cause: 'manual', bytes: rec.bytes } });
    expect((await call(t.app, `/api/v1/recordings/${rec.id}`, { cookie: admin.cookie })).json().deletedAt).toBeTruthy();
  });

  it('retention policy GET / PATCH and the sweeper deletes expired recordings (actor system)', async () => {
    const tech = await addMember(t.app, admin, 'technician');
    expect((await call(t.app, '/api/v1/orgs/current/policy/retention', { cookie: tech.cookie })).json()).toEqual({ recordingRetentionDays: null });
    expect((await call(t.app, '/api/v1/orgs/current/policy/retention', { method: 'PATCH', cookie: tech.cookie, body: { recordingRetentionDays: 7 } })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/orgs/current/policy/retention', { method: 'PATCH', cookie: admin.cookie, body: { recordingRetentionDays: 0 } })).statusCode).toBe(400);
    const ok = await call(t.app, '/api/v1/orgs/current/policy/retention', { method: 'PATCH', cookie: admin.cookie, body: { recordingRetentionDays: 7 } });
    expect(ok.json()).toEqual({ recordingRetentionDays: 7 });
    const sid = await activeP2(admin);
    const rec = (await uploadRrweb(admin, sid)).res.json();
    await t.db.update(recording).set({ storedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(recording.id, rec.id));
    expect(await new Sweeper(t.ctx).retention()).toBeGreaterThanOrEqual(1);
    expect((await getRecording(t.db, rec.id))?.deletedAt).toBeInstanceOf(Date);
    const audit = (await call(t.app, `/api/v1/sessions/${sid}/audit`, { cookie: admin.cookie })).json();
    expect(audit.items.find((e: { action: string }) => e.action === 'recording.deleted')).toMatchObject({ actor: { type: 'system' }, data: { cause: 'retention' } });
    const residency = (await call(t.app, '/api/v1/orgs/current/residency', { cookie: admin.cookie })).json();
    expect(residency).toMatchObject({ recordingRetentionDays: 7, extensionPolicy: { allowRelayFallback: true, recordRevealed: false }, relaySessions: 0, relayBytes: 0 });
    await call(t.app, '/api/v1/orgs/current/policy/retention', { method: 'PATCH', cookie: admin.cookie, body: { recordingRetentionDays: null } });
  });
});
