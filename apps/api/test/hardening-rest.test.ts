/** Regression tests for the REST-side review fixes (SEC-01, SEC-04, SEC-06, SEC-07, SEC-08, SEC-11, correctness-F10). */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import {
  endSession,
  getOrg,
  getRecordingBySession,
  getUser,
  insertToken,
  seedSession,
  seedToken,
  transitionSession,
} from '@indiansassist/db';
import { luhnValid } from '@indiansassist/shared';
import { serializeError } from '../src/lib/logger.js';
import { addMember, call, makeApp, signup, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;
let tech: Account;
let tech2: Account;

/** A 12-digit code (first digit 1-9) whose check digit is wrong. */
function luhnFreeCodeForTest(): string {
  for (;;) {
    const c = `9${randomBytes(8).readBigUInt64BE().toString().padStart(11, '0').slice(0, 11)}`;
    if (!luhnValid(c)) return c;
  }
}

beforeAll(async () => {
  t = await makeApp({ USER_MAX_OPEN_UPLOADS: '1', ORG_STORAGE_QUOTA_BYTES: String(3 * 1024 ** 3) });
  admin = await signup(t.app);
  tech = await addMember(t.app, admin, 'technician');
  tech2 = await addMember(t.app, admin, 'technician');
});
afterAll(async () => {
  await t.close();
});

/** A session on a token of `owner` in the requested end state. */
async function sessionOf(owner: Account, upTo: 'knocked' | 'accepted' | 'active'): Promise<string> {
  const org = (await getOrg(t.db, owner.org.id))!;
  const user = (await getUser(t.db, owner.user.id))!;
  const tok = await seedToken(t.db, org, user);
  const s = await seedSession(t.db, tok, { assistUserId: user.id });
  if (upTo === 'knocked') return s.id;
  await transitionSession(t.db, s.id, 'accepted', { set: { assistUserId: user.id } });
  if (upTo === 'accepted') return s.id;
  await transitionSession(t.db, s.id, 'consent_pending');
  await transitionSession(t.db, s.id, 'active', { set: { consentSurface: 'monitor' } });
  return s.id;
}

function multipart(meta: unknown, file: Buffer): { body: Buffer; type: string } {
  const b = `----ia${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="rec.webm"\r\nContent-Type: video/webm\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}

function upload(acc: Account, sid: string, file: Buffer, mime = 'video/webm') {
  const mp = multipart({ mime }, file);
  return call(t.app, `/api/v1/sessions/${sid}/recordings`, { cookie: acc.cookie, body: mp.body, headers: { 'content-type': mp.type } });
}

const fileEvent = (fileId: number) => ({
  action: 'file.sent',
  data: { fileId, direction: 'assist_to_desk', name: 'a.txt', bytes: 3, sha256: 'b'.repeat(64) },
});

describe('SEC-01 recording mime and /file headers', () => {
  it('refuses a non-webm mime with 400 and serves stored bytes as a sandboxed webm download', async () => {
    const sid = await sessionOf(tech, 'active');
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const bad = await upload(tech, sid, html, 'text/html');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    const init = await call(t.app, `/api/v1/sessions/${sid}/recordings/uploads`, {
      cookie: tech.cookie,
      body: { mime: 'application/javascript', bytes: 10 },
    });
    expect(init.statusCode).toBe(400);
    expect(await getRecordingBySession(t.db, sid)).toBeNull();

    const ok = await upload(tech, sid, html, 'video/webm;codecs=vp9,opus');
    expect(ok.statusCode).toBe(201);
    const dl = (await call(t.app, `/api/v1/recordings/${ok.json().id}/download`, { cookie: tech.cookie })).json();
    const file = await call(t.app, new URL(dl.url as string).pathname + new URL(dl.url as string).search);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('video/webm');
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${ok.json().id}.webm"`);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(file.headers['cache-control']).toBe('private, no-store');
  });
});

describe('SEC-06 / F10 upload preconditions', () => {
  it('a session that ended from knocked has no assist: recordings, recording.started and ICE are 403', async () => {
    const sid = await sessionOf(tech, 'knocked');
    await endSession(t.db, sid, 'denied');
    expect((await upload(tech, sid, randomBytes(10))).statusCode).toBe(403);
    const ev = await call(t.app, `/api/v1/sessions/${sid}/events`, { cookie: tech.cookie, body: { action: 'recording.started', data: {} } });
    expect(ev.statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/ice?sessionId=${sid}`, { cookie: tech.cookie })).statusCode).toBe(403);
  });

  it('an accepted session that never reached active cannot carry a recording; an empty file is refused', async () => {
    const accepted = await sessionOf(tech, 'accepted');
    await endSession(t.db, accepted, 'timeout');
    expect((await upload(tech, accepted, randomBytes(10))).statusCode).toBe(403);
    const sid = await sessionOf(tech, 'active');
    const empty = await upload(tech, sid, Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    expect((await getRecordingBySession(t.db, sid))?.status).toBe('failed');
    // The failed row is reused by a real upload.
    expect((await upload(tech, sid, randomBytes(64))).statusCode).toBe(201);
  });
});

describe('SEC-08 storage quotas', () => {
  it('limits open uploads per user and bytes per org', async () => {
    const a = await sessionOf(tech, 'active');
    const b = await sessionOf(tech, 'active');
    const first = await call(t.app, `/api/v1/sessions/${a}/recordings/uploads`, { cookie: tech.cookie, body: { mime: 'video/webm', bytes: 1024 } });
    expect(first.statusCode).toBe(201);
    const second = await call(t.app, `/api/v1/sessions/${b}/recordings/uploads`, { cookie: tech.cookie, body: { mime: 'video/webm', bytes: 1024 } });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('rate_limited');
    // Other users have their own open-upload budget, but the org byte quota (3 GiB, open uploads included) is shared.
    const c = await sessionOf(admin, 'active');
    const big = await call(t.app, `/api/v1/sessions/${c}/recordings/uploads`, { cookie: admin.cookie, body: { mime: 'video/webm', bytes: 2 * 1024 ** 3 } });
    expect(big.statusCode).toBe(201);
    const d = await sessionOf(tech2, 'active');
    const over = await call(t.app, `/api/v1/sessions/${d}/recordings/uploads`, { cookie: tech2.cookie, body: { mime: 'video/webm', bytes: 1024 ** 3 } });
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe('payload_too_large');
  });
});

describe('SEC-04 REST file attestations', () => {
  it('needs a session that reached active, caps fileId and writes one entry per transfer', async () => {
    const accepted = await sessionOf(tech, 'accepted');
    expect((await call(t.app, `/api/v1/sessions/${accepted}/events`, { cookie: tech.cookie, body: fileEvent(1) })).statusCode).toBe(403);
    const sid = await sessionOf(tech, 'active');
    expect((await call(t.app, `/api/v1/sessions/${sid}/events`, { cookie: tech.cookie, body: fileEvent(10_001) })).statusCode).toBe(400);
    const one = await call(t.app, `/api/v1/sessions/${sid}/events`, { cookie: tech.cookie, body: fileEvent(7) });
    expect(one.statusCode).toBe(201);
    const again = await call(t.app, `/api/v1/sessions/${sid}/events`, { cookie: tech.cookie, body: fileEvent(7) });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(one.json().id);
    const audit = (await call(t.app, `/api/v1/sessions/${sid}/audit`, { cookie: tech.cookie })).json();
    expect(audit.items.filter((e: { action: string }) => e.action === 'file.sent')).toHaveLength(1);
  });
});

describe('SEC-11 Luhn pre-check on short codes', () => {
  it('a Luhn-invalid code never reaches the database, even if a row with it exists', async () => {
    const org = (await getOrg(t.db, admin.org.id))!;
    const code = luhnFreeCodeForTest();
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    await insertToken(t.db, {
      id: randomUUID(),
      orgId: org.id,
      createdBy: admin.user.id,
      tier: 'p1_browser',
      typ: 'one_time',
      label: null,
      region: org.dataRegion,
      kid: '0000000000000000',
      signature: 'test-signature',
      nonce: randomBytes(16).toString('base64url'),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 15 * 60_000),
      shortCode: code,
    });
    const res = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('token_not_found');
  });
});

describe('SEC-07 error serializer', () => {
  it('drops the SQL and bound parameters of a DrizzleQueryError', () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505', constraint: 'x' });
    const err = new DrizzleQueryError('insert into "token" ("signature") values ($1)', ['super-secret-signature'], cause);
    const out = serializeError(err);
    const text = JSON.stringify(out);
    expect(text).not.toContain('super-secret-signature');
    expect(text).not.toContain('insert into');
    expect(out).toMatchObject({ type: 'DrizzleQueryError', message: 'drizzle query failed', code: '23505', constraint: 'x' });
  });

  it('truncates long messages and copies no arbitrary own properties', () => {
    const err = Object.assign(new Error('m'.repeat(2000)), { params: ['p'], passwordHash: 'h', code: 'E1' });
    const out = serializeError(err);
    expect(String(out.message).length).toBeLessThan(600);
    expect(JSON.stringify(out)).not.toContain('passwordHash');
    expect(out.code).toBe('E1');
    expect(String(out.stack).split('\n')[0]!.length).toBeLessThan(600);
  });
});
