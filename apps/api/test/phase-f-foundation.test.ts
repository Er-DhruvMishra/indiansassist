/**
 * Phase F foundation plumbing (docs/specs/phase-f-contracts.md sections 1.4, 5.3, 6.4, 12, 13, 16.2): the hooks land
 * without behaviour. The stream route plugins register nothing; `ObjectStorage.list(prefix)` on both drivers; the
 * `org_erasing` gate on REST, login, the Assist socket upgrade and `piiHash`; the camera side refused by its stubs
 * and no Desk speaking as the camera; the zero-initialised series; and `role_since` / `role_granted_by` /
 * `inviteMailedAt` on the users routes.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authOptionsSchema } from '@indiansassist/shared';
import { getOrg, getUser, org as orgTable, OrgErasedError } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsObjectStorage } from '../src/adapters/storage-fs.js';
import { S3ObjectStorage } from '../src/adapters/storage-s3.js';
import { piiHash } from '../src/lib/audit.js';
import { addMember, call, listen, PASSWORD, signup, SignalClient, makeApp, type TestApp } from './helpers.js';

async function collect(it: AsyncIterable<{ key: string; bytes: number }>): Promise<{ key: string; bytes: number }[]> {
  const out: { key: string; bytes: number }[] = [];
  for await (const x of it) out.push(x);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

describe('ObjectStorage.list(prefix) (section 5.3 step 4)', () => {
  it('fs walks the prefix, skipping sidecars and temp files, and never matches a sibling prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ia-list-'));
    try {
      const s = new FsObjectStorage({ root, fileOrigin: 'http://localhost:4000', presignKey: Buffer.alloc(32) });
      await s.put('in-mum/org1/s1/r1.webm', new Uint8Array([1, 2, 3]), { contentType: 'video/webm' });
      await s.put('in-mum/org1/s1/r1.webm.part1', new Uint8Array([4]), { contentType: 'application/octet-stream' });
      await s.put('in-mum/org1/s2/r2.webm', new Uint8Array(10), { contentType: 'video/webm' });
      await s.put('in-mum/org10/s3/r3.webm', new Uint8Array(1), { contentType: 'video/webm' });
      mkdirSync(join(root, 'in-mum', 'org1', 's2'), { recursive: true });
      writeFileSync(join(root, 'in-mum', 'org1', 's2', 'x.webm.0f.tmp'), 'partial');
      expect(await collect(s.list('in-mum/org1/'))).toEqual([
        { key: 'in-mum/org1/s1/r1.webm', bytes: 3 },
        { key: 'in-mum/org1/s1/r1.webm.part1', bytes: 1 },
        { key: 'in-mum/org1/s2/r2.webm', bytes: 10 },
      ]);
      expect(await collect(s.list('in-mum/nobody/'))).toEqual([]);
      await expect(collect(s.list('in-mum/org1'))).rejects.toThrow(/must end with/);
      await expect(collect(s.list('../x/'))).rejects.toThrow(/invalid storage key/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('s3 pages ListObjectsV2 with the continuation token', async () => {
    const sent: Record<string, unknown>[] = [];
    const pages = [
      { Contents: [{ Key: 'in-mum/org1/a', Size: 5 }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Key: 'in-mum/org1/b', Size: 7 }], IsTruncated: false },
    ];
    const client = {
      send: (cmd: { input: Record<string, unknown> }) => {
        sent.push(cmd.input);
        return Promise.resolve(pages[sent.length - 1]);
      },
    };
    const s = new S3ObjectStorage(
      { endpoint: 'http://s3.example.test', region: 'x', bucket: 'b', accessKey: 'k', secretKey: 's', forcePathStyle: true },
      client as never,
    );
    expect(await collect(s.list('in-mum/org1/'))).toEqual([
      { key: 'in-mum/org1/a', bytes: 5 },
      { key: 'in-mum/org1/b', bytes: 7 },
    ]);
    expect(sent).toEqual([
      { Bucket: 'b', Prefix: 'in-mum/org1/' },
      { Bucket: 'b', Prefix: 'in-mum/org1/', ContinuationToken: 't1' },
    ]);
  });
});

describe('Phase F api hooks', () => {
  let t: TestApp;
  let url: string;

  beforeAll(async () => {
    t = await makeApp();
    url = await listen(t.app);
  });
  afterAll(async () => {
    await t.close();
  });

  it('the stream route plugins are registered (built in wave 1)', async () => {
    const options = await call(t.app, '/api/v1/auth/options');
    expect(options.statusCode).toBe(200);
    expect(authOptionsSchema.safeParse(options.json()).success).toBe(true);
    // The certificate route exists and answers 404 for an erasure that is not completed (here: unknown).
    const cert = await call(t.app, `/api/v1/erasures/${randomUUID()}/certificate`);
    expect(cert.statusCode).toBe(404);
    expect(cert.json()).toMatchObject({ error: { code: 'not_found', message: 'erasure certificate not found' } });
  });

  it('registers the Phase F series zero-initialised', async () => {
    const text = await t.ctx.metrics.registry.metrics();
    expect(text).toContain('ia_mail_sent_total{kind="invite",result="no_mailer"} 0');
    expect(text).toContain('ia_password_resets_total{result="unknown"} 0');
    expect(text).toContain('ia_erasures_total{state="completed"} 0');
    expect(text).toContain('ia_camera_sessions_total{tier="p1_browser",result="live"} 0');
  });

  it('invite and role change write role_since and role_granted_by; users carry inviteMailedAt', async () => {
    const admin = await signup(t.app);
    const signupRow = (await getUser(t.db, admin.user.id))!;
    expect(signupRow.roleGrantedBy).toBeNull();
    const inv = await call(t.app, '/api/v1/users/invite', {
      cookie: admin.cookie,
      body: { email: `inv-${randomUUID().slice(0, 8)}@example.test`, name: 'Ravi K', role: 'technician' },
    });
    expect(inv.statusCode).toBe(201);
    const invited = (inv.json() as { user: { id: string; inviteMailedAt: unknown } }).user;
    expect(invited.inviteMailedAt).toBeNull();
    const row = (await getUser(t.db, invited.id))!;
    expect(row.roleGrantedBy).toBe(admin.user.id);
    const before = row.roleSince.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const ch = await call(t.app, `/api/v1/users/${invited.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'observer' } });
    expect(ch.statusCode).toBe(200);
    const after = (await getUser(t.db, invited.id))!;
    expect(after.roleSince.getTime()).toBeGreaterThan(before);
    expect(after.roleGrantedBy).toBe(admin.user.id);
  });

  it('camera side: an unknown code is refused and a Desk cannot speak as the camera', async () => {
    const cam = await SignalClient.open(url);
    const err = await cam.request({ t: 'camera.hello', code: 'ABCD-EFGH-JKMN' }, 'error');
    expect(err.code).toBe('camera_link_invalid');
    expect(await cam.closed()).toBe(4403);
    const desk = await SignalClient.open(url, { origin: null });
    const refused = await desk.request({ t: 'camera.hello', code: 'ABCD-EFGH-JKMN' }, 'error');
    expect(refused.code).toBe('forbidden');
  });

  it('org_erasing: REST, login, the Assist socket upgrade and piiHash', async () => {
    const admin = await signup(t.app);
    const member = await addMember(t.app, admin, 'technician');
    expect((await call(t.app, '/api/v1/auth/me', { cookie: admin.cookie })).statusCode).toBe(200);
    await t.db.update(orgTable).set({ erasingAt: new Date() }).where(eq(orgTable.id, admin.org.id));
    const me = await call(t.app, '/api/v1/auth/me', { cookie: member.cookie });
    expect(me.statusCode).toBe(409);
    expect(me.json()).toMatchObject({ error: { code: 'org_erasing' } });
    const users = await call(t.app, '/api/v1/users', { cookie: admin.cookie });
    expect(users.json()).toMatchObject({ error: { code: 'org_erasing' } });
    const memberRow = (await getUser(t.db, member.user.id))!;
    const login = await call(t.app, '/api/v1/auth/login', { body: { email: memberRow.email, password: PASSWORD } });
    expect(login.statusCode).toBe(409);
    expect(login.json()).toMatchObject({ error: { code: 'org_erasing' } });
    await expect(SignalClient.open(url, { cookie: admin.cookie })).rejects.toThrow(/upgrade refused 409/);
    // Another org is untouched.
    const other = await signup(t.app);
    expect((await call(t.app, '/api/v1/auth/me', { cookie: other.cookie })).statusCode).toBe(200);
    // After the seal step the pepper is gone: piiHash refuses rather than hashing "null:" + value.
    await t.db.update(orgTable).set({ auditPepper: null, erasedAt: new Date() }).where(eq(orgTable.id, admin.org.id));
    const erased = (await getOrg(t.db, admin.org.id))!;
    expect(() => piiHash(erased, 'someone@example.test')).toThrow(OrgErasedError);
  });
});
