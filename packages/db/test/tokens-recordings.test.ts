import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrgUser,
  createOrgWithAdmin,
  expireTokenIfDue,
  findTokenByShortCode,
  findTokenByTid,
  getRecording,
  getRecordingBySession,
  incrementTokenDenied,
  insertRecording,
  insertTokenWithShortCode,
  listExpiredUploads,
  listRecordingsBySession,
  listTokensByOrg,
  markRecordingFailed,
  markRecordingStored,
  markTokenUsed,
  recordingStorageKey,
  resetRecordingForUpload,
  resetTokenDenied,
  revokeToken,
  seedSession,
  seedToken,
  ShortCodeExhaustedError,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb } from './helpers.js';

describe('tokens', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db);
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('inserts and finds by tid and by active short code only', async () => {
    const tok = await seedToken(db, s.org, s.user, { label: 'Laptop' });
    expect(tok.shortCode).toMatch(/^[1-9]\d{11}$/);
    expect((await findTokenByTid(db, tok.id))?.label).toBe('Laptop');
    expect((await findTokenByShortCode(db, tok.shortCode))?.id).toBe(tok.id);
    const used = await markTokenUsed(db, tok.id);
    expect(used).toMatchObject({ status: 'used' });
    expect(used?.usedAt).toBeInstanceOf(Date);
    expect(await markTokenUsed(db, tok.id)).toBeNull();
    expect(await findTokenByShortCode(db, tok.shortCode)).toBeNull();
  });

  it('retries a short code that collides with an active token, and gives up eventually', async () => {
    const first = await seedToken(db, s.org, s.user);
    const codes = [first.shortCode, first.shortCode, '123456789012'];
    const base = {
      orgId: s.org.id,
      createdBy: s.user.id,
      tier: 'p1_browser' as const,
      typ: 'timed' as const,
      region: s.org.dataRegion,
      kid: '0000000000000000',
      signature: 'sig',
      nonce: 'n',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const tok = await insertTokenWithShortCode(db, { ...base, id: randomUUID() }, { generate: () => codes.shift()! });
    expect(tok.shortCode).toBe('123456789012');
    await expect(
      insertTokenWithShortCode(db, { ...base, id: randomUUID() }, { generate: () => first.shortCode, maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(ShortCodeExhaustedError);
    // a used token's code may be reused by a new active token
    await markTokenUsed(db, first.id);
    const reuse = await insertTokenWithShortCode(
      db,
      { ...base, id: randomUUID() },
      { generate: () => first.shortCode },
    );
    expect(reuse.shortCode).toBe(first.shortCode);
  });

  it('revokes idempotently and tracks denials', async () => {
    const tok = await seedToken(db, s.org, s.user);
    const r1 = await revokeToken(db, tok.id, s.user.id);
    expect(r1).toMatchObject({ changed: true, token: { status: 'revoked', revokedBy: s.user.id } });
    const r2 = await revokeToken(db, tok.id, s.user.id);
    expect(r2?.changed).toBe(false);
    expect(await revokeToken(db, randomUUID(), null)).toBeNull();
    expect(await incrementTokenDenied(db, tok.id)).toBe(1);
    expect(await incrementTokenDenied(db, tok.id)).toBe(2);
    await resetTokenDenied(db, tok.id);
    expect((await findTokenByTid(db, tok.id))?.deniedCount).toBe(0);
  });

  it('lists newest first with effective status filters, own scope and cursors', async () => {
    const o = await createOrgWithAdmin(db);
    const { user: tech } = await createOrgUser(db, o.org, { role: 'technician' });
    const expired = await seedToken(db, o.org, o.user, { issuedAt: new Date(Date.now() - 3600_000), ttlMs: 60_000 });
    const active = [];
    for (let i = 0; i < 3; i++) active.push(await seedToken(db, o.org, o.user));
    const techTok = await seedToken(db, o.org, tech);

    const act = await listTokensByOrg(db, o.org.id, { status: 'active' });
    expect(act.items.map((t) => t.id)).toEqual([techTok.id, ...active.map((t) => t.id).reverse()]);
    const exp = await listTokensByOrg(db, o.org.id, { status: 'expired' });
    expect(exp.items.map((t) => [t.id, t.status, t.effectiveStatus])).toEqual([[expired.id, 'active', 'expired']]);
    expect((await listTokensByOrg(db, o.org.id, { createdBy: tech.id })).items.map((t) => t.id)).toEqual([techTok.id]);

    const p1 = await listTokensByOrg(db, o.org.id, { limit: 3 });
    const p2 = await listTokensByOrg(db, o.org.id, { limit: 3, cursor: p1.nextCursor });
    expect([...p1.items, ...p2.items].map((t) => t.id)).toEqual([
      techTok.id,
      ...active.map((t) => t.id).reverse(),
      expired.id,
    ]);
    expect(p2.nextCursor).toBeNull();

    expect((await expireTokenIfDue(db, expired.id))?.status).toBe('expired');
    expect(await expireTokenIfDue(db, active[0]!.id)).toBeNull();
  });
});

describe('recordings', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db);
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('inserts, gets, lists by session and walks the status lifecycle', async () => {
    const sess = await seedSession(db, await seedToken(db, s.org, s.user));
    const id = randomUUID();
    const key = recordingStorageKey(s.org.dataRegion, s.org.id, sess.id, id);
    expect(key).toBe(`in-mum/${s.org.id}/${sess.id}/${id}.webm`);
    const rec = await insertRecording(db, {
      id,
      orgId: s.org.id,
      sessionId: sess.id,
      uploadedBy: s.user.id,
      storageKey: key,
      region: s.org.dataRegion,
      bytes: 2048,
      uploadId: 'up-1',
      uploadExpiresAt: new Date(Date.now() - 1000),
    });
    expect(rec).toMatchObject({ status: 'uploading', mime: 'video/webm', bytes: 2048, sha256: null });
    expect((await getRecording(db, id))?.storageKey).toBe(key);
    expect((await getRecordingBySession(db, sess.id))?.id).toBe(id);
    expect((await listRecordingsBySession(db, sess.id)).map((r) => r.id)).toEqual([id]);
    expect((await listExpiredUploads(db)).map((r) => r.id)).toEqual([id]);

    // one recording per session
    await expect(
      insertRecording(db, {
        orgId: s.org.id,
        sessionId: sess.id,
        uploadedBy: s.user.id,
        storageKey: key + '2',
        region: s.org.dataRegion,
      }),
    ).rejects.toThrow();

    expect((await markRecordingFailed(db, id)).status).toBe('failed');
    expect((await resetRecordingForUpload(db, id, { bytes: 4096 })).status).toBe('uploading');
    const stored = await markRecordingStored(db, id, { sha256: 'd'.repeat(64), bytes: 4096 });
    expect(stored).toMatchObject({ status: 'stored', sha256: 'd'.repeat(64), bytes: 4096, uploadExpiresAt: null });
    expect(stored.storedAt).toBeInstanceOf(Date);
    expect(await listExpiredUploads(db)).toEqual([]);
    expect(await getRecording(db, randomUUID())).toBeNull();
  });
});
