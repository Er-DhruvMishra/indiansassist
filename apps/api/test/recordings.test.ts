import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAuditEntry,
  getOrg,
  getUser,
  seedSession,
  seedToken,
  transitionSession,
} from '@indiansassist/db';
import { presignSignature } from '../src/lib/crypto.js';
import { addMember, call, makeApp, signup, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;
let tech: Account;

beforeAll(async () => {
  t = await makeApp();
  admin = await signup(t.app);
  tech = await addMember(t.app, admin, 'technician');
});
afterAll(async () => {
  await t.close();
});

/** An `active` session on a token of `owner`, accepted by `owner`. */
async function activeSession(owner: Account): Promise<string> {
  const org = (await getOrg(t.db, owner.org.id))!;
  const user = (await getUser(t.db, owner.user.id))!;
  const tok = await seedToken(t.db, org, user);
  const s = await seedSession(t.db, tok, { assistUserId: user.id });
  await transitionSession(t.db, s.id, 'accepted', { set: { assistUserId: user.id } });
  await transitionSession(t.db, s.id, 'consent_pending');
  await transitionSession(t.db, s.id, 'active', { set: { consentSurface: 'monitor' } });
  return s.id;
}

function multipart(meta: unknown, file: Buffer, metaFirst = true): { body: Buffer; type: string } {
  const b = `----ia${randomBytes(8).toString('hex')}`;
  const metaPart = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`);
  const filePart = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="rec.webm"\r\nContent-Type: video/webm\r\n\r\n`),
    file,
    Buffer.from('\r\n'),
  ]);
  const parts = metaFirst ? [metaPart, filePart] : [filePart, metaPart];
  return { body: Buffer.concat([...parts, Buffer.from(`--${b}--\r\n`)]), type: `multipart/form-data; boundary=${b}` };
}

async function upload(acc: Account, sessionId: string, file: Buffer) {
  const mp = multipart({ mime: 'video/webm', durationMs: 20000 }, file);
  return call(t.app, `/api/v1/sessions/${sessionId}/recordings`, { cookie: acc.cookie, body: mp.body, headers: { 'content-type': mp.type } });
}

describe('recordings', () => {
  it('streams a multipart upload through sha256, stores it and chains recording.stored', async () => {
    const sid = await activeSession(tech);
    const file = randomBytes(200_000);
    const sha = createHash('sha256').update(file).digest('hex');
    const res = await upload(tech, sid, file);
    expect(res.statusCode).toBe(201);
    const rec = res.json();
    expect(rec).toMatchObject({ sessionId: sid, status: 'stored', mime: 'video/webm', bytes: file.length, sha256: sha, durationMs: 20000, region: 'in-mum' });
    expect(rec.storageKey).toBe(`in-mum/${admin.org.id}/${sid}/${rec.id}.webm`);
    const entry = await getAuditEntry(t.db, rec.chainedInto);
    expect(entry).toMatchObject({ action: 'recording.stored', sessionId: sid });
    expect(entry?.data).toEqual({ recordingId: rec.id, sha256: sha, bytes: file.length, mime: 'video/webm', storageKey: rec.storageKey });

    const dup = await upload(tech, sid, file);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('recording_exists');

    const session = (await call(t.app, `/api/v1/sessions/${sid}`, { cookie: tech.cookie })).json();
    expect(session.recordingId).toBe(rec.id);

    const verify = await call(t.app, `/api/v1/recordings/${rec.id}/verify`, { cookie: admin.cookie, method: 'POST' });
    expect(verify.json()).toEqual({ ok: true, sha256: sha, expectedSha256: sha, chainSha256: sha, bytes: file.length, chainedInto: rec.chainedInto });

    // Presigned download through the fs driver's signed route.
    const dl = await call(t.app, `/api/v1/recordings/${rec.id}/download`, { cookie: tech.cookie });
    expect(dl.statusCode).toBe(200);
    const u = new URL(dl.json().url);
    expect(u.origin).toBe('http://localhost:4000');
    const got = await call(t.app, u.pathname + u.search);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('video/webm');
    expect(Buffer.compare(got.rawPayload, file)).toBe(0);
    const tampered = await call(t.app, `${u.pathname}?exp=${u.searchParams.get('exp')}&sig=${'0'.repeat(64)}`);
    expect(tampered.statusCode).toBe(404);
    const past = Math.floor(Date.now() / 1000) - 10;
    const expiredSig = presignSignature(t.ctx.presignKey, rec.id, rec.storageKey, past);
    const expired = await call(t.app, `${u.pathname}?exp=${past}&sig=${expiredSig}`);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('link_expired');
  });

  it('gates metadata and download by role and scope', async () => {
    const sid = await activeSession(tech);
    const rec = (await upload(tech, sid, randomBytes(1000))).json();
    const observer = await addMember(t.app, admin, 'observer');
    const auditor = await addMember(t.app, admin, 'auditor');
    const tech2 = await addMember(t.app, admin, 'technician');
    expect((await call(t.app, `/api/v1/recordings/${rec.id}`, { cookie: observer.cookie })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/recordings/${rec.id}/download`, { cookie: observer.cookie })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/recordings/${rec.id}`, { cookie: tech2.cookie })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/recordings/${rec.id}/download`, { cookie: auditor.cookie })).statusCode).toBe(200);
    const other = await signup(t.app);
    expect((await call(t.app, `/api/v1/recordings/${rec.id}`, { cookie: other.cookie })).statusCode).toBe(404);
    // Only the assist of the session may upload.
    const sid2 = await activeSession(tech);
    expect((await upload(admin, sid2, randomBytes(10))).statusCode).toBe(403);
  });

  it('rejects a file before meta and supports chunked uploads', async () => {
    const sid = await activeSession(tech);
    const mp = multipart({ mime: 'video/webm' }, randomBytes(10), false);
    const bad = await call(t.app, `/api/v1/sessions/${sid}/recordings`, { cookie: tech.cookie, body: mp.body, headers: { 'content-type': mp.type } });
    expect(bad.statusCode).toBe(400);

    const tooBig = await call(t.app, `/api/v1/sessions/${sid}/recordings/uploads`, { cookie: tech.cookie, body: { mime: 'video/webm', bytes: 3 * 1024 ** 3 } });
    expect(tooBig.statusCode).toBe(413);

    const sid2 = await activeSession(tech);
    const incomplete = await call(t.app, `/api/v1/sessions/${sid2}/recordings/uploads`, { cookie: tech.cookie, body: { mime: 'video/webm', bytes: 16 * 1024 * 1024 + 10 } });
    expect(incomplete.statusCode).toBe(201);
    expect(incomplete.json()).toMatchObject({ partSize: 16777216, parts: 2 });
    const done = await call(t.app, `/api/v1/recordings/uploads/${incomplete.json().uploadId}/complete`, { cookie: tech.cookie, body: { parts: 2 } });
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toMatchObject({ code: 'upload_incomplete', details: { missing: [1, 2] } });

    // A complete single-part chunked upload: exact part size, range check, assembly, parts deleted.
    const sid3 = await activeSession(tech);
    const file = randomBytes(5000);
    const init = await call(t.app, `/api/v1/sessions/${sid3}/recordings/uploads`, { cookie: tech.cookie, body: { mime: 'video/webm', bytes: file.length } });
    expect(init.json().parts).toBe(1);
    const { uploadId, recordingId } = init.json();
    const wrongSize = await call(t.app, `/api/v1/recordings/uploads/${uploadId}/parts/1`, {
      method: 'PUT',
      cookie: tech.cookie,
      body: file.subarray(0, 10),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(wrongSize.statusCode).toBe(400);
    const part = await call(t.app, `/api/v1/recordings/uploads/${uploadId}/parts/1`, {
      method: 'PUT',
      cookie: tech.cookie,
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(part.statusCode).toBe(200);
    expect(part.json()).toEqual({ n: 1, bytes: file.length });
    const outOfRange = await call(t.app, `/api/v1/recordings/uploads/${uploadId}/parts/2`, {
      method: 'PUT',
      cookie: tech.cookie,
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(outOfRange.statusCode).toBe(400);
    const complete = await call(t.app, `/api/v1/recordings/uploads/${uploadId}/complete`, { cookie: tech.cookie, body: { parts: 1 } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      id: recordingId,
      status: 'stored',
      bytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
    });
    expect(await t.ctx.storage.head(`${complete.json().storageKey}.part1`)).toBeNull();
  });
});
