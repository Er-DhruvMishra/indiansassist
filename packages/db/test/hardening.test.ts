/** Review fixes: partial unique open-session index, lock helpers, sweeper and quota queries, auth session by id. */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAuthSession,
  createOrgWithAdmin,
  endSession,
  findValidAuthSessionById,
  insertAuditEntry,
  insertRecording,
  isUniqueViolation,
  listActiveTokensByCreator,
  listOpenSessionsOnRevokedTokens,
  lockToken,
  markRecordingFailed,
  markRecordingStored,
  recordingStorageKey,
  recordingUsage,
  revokeAuthSession,
  revokeToken,
  seedSession,
  seedToken,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb } from './helpers.js';

let db: Db;
let s: SeededOrg;
beforeAll(async () => {
  db = await freshDb();
  s = await createOrgWithAdmin(db);
});
afterAll(async () => {
  await closeDb(db);
});

describe('session_token_open_unique (correctness-F2)', () => {
  it('refuses a second non-ended session on the same token and allows one after the first ended', async () => {
    const tok = await seedToken(db, s.org, s.user, { typ: 'timed' });
    const first = await seedSession(db, tok);
    let err: unknown = null;
    try {
      await seedSession(db, tok);
    } catch (e) {
      err = e;
    }
    expect(isUniqueViolation(err, 'session_token_open_unique')).toBe(true);
    await endSession(db, first.id, 'assist_ended');
    const second = await seedSession(db, tok);
    expect(second.state).toBe('knocked');
  });
});

describe('lock helpers and sweeper queries', () => {
  it('lockToken and listActiveTokensByCreator({ forUpdate }) work inside a transaction', async () => {
    const tok = await seedToken(db, s.org, s.user);
    const locked = await db.transaction(async (tx) => {
      const row = await lockToken(tx, tok.id);
      const mine = await listActiveTokensByCreator(tx, s.user.id, { forUpdate: true });
      return { row, ids: mine.map((t) => t.id) };
    });
    expect(locked.row?.id).toBe(tok.id);
    expect(locked.ids).toContain(tok.id);
  });

  it('lists non-ended sessions whose token is revoked', async () => {
    const tok = await seedToken(db, s.org, s.user);
    const open = await seedSession(db, tok);
    expect((await listOpenSessionsOnRevokedTokens(db)).map((x) => x.id)).not.toContain(open.id);
    await revokeToken(db, tok.id, s.user.id);
    expect((await listOpenSessionsOnRevokedTokens(db)).map((x) => x.id)).toContain(open.id);
    await endSession(db, open.id, 'token_revoked');
    expect((await listOpenSessionsOnRevokedTokens(db)).map((x) => x.id)).not.toContain(open.id);
  });

  it('an audit append on a session works on its own and inside a transaction that already updated the row', async () => {
    const tok = await seedToken(db, s.org, s.user, { typ: 'timed' });
    const sess = await seedSession(db, tok);
    const e1 = await insertAuditEntry(db, {
      orgId: s.org.id,
      region: s.org.dataRegion,
      sessionId: sess.id,
      actor: { type: 'system', id: null, label: 'system' },
      action: 'session.knock',
      data: { tokenId: tok.id, deskLabelHash: 'a'.repeat(64), userAgentHash: 'b'.repeat(64) },
    });
    const e2 = await db.transaction(async (tx) => {
      await endSession(tx, sess.id, 'assist_ended');
      return insertAuditEntry(tx, {
        orgId: s.org.id,
        region: s.org.dataRegion,
        sessionId: sess.id,
        actor: { type: 'system', id: null, label: 'system' },
        action: 'session.ended',
        data: { endReason: 'assist_ended', durationMs: null, path: 'unknown' },
      });
    });
    expect(e2.seq).toBe(e1.seq + 1);
  });
});

describe('recordingUsage (SEC-08)', () => {
  it('counts uploading rows per org and user and sums non-failed bytes', async () => {
    const org = await createOrgWithAdmin(db);
    const mk = async (bytes: number) => {
      const tok = await seedToken(db, org.org, org.user, { typ: 'timed' });
      const sess = await seedSession(db, tok);
      return insertRecording(db, {
        orgId: org.org.id,
        sessionId: sess.id,
        uploadedBy: org.user.id,
        storageKey: recordingStorageKey(org.org.dataRegion, org.org.id, sess.id, sess.id),
        region: org.org.dataRegion,
        mime: 'video/webm',
        bytes,
      });
    };
    const a = await mk(100);
    const b = await mk(50);
    const c = await mk(7);
    await markRecordingStored(db, a.id, { sha256: 'c'.repeat(64), bytes: 100 });
    await markRecordingFailed(db, c.id);
    const u = await recordingUsage(db, org.org.id, org.user.id);
    expect(u).toEqual({ orgUploading: 1, userUploading: 1, orgBytes: 150 });
    expect(b.status).toBe('uploading');
  });
});

describe('findValidAuthSessionById (SEC-02)', () => {
  it('returns the session and user until it is revoked', async () => {
    const row = await createAuthSession(db, {
      userId: s.user.id,
      tokenHash: createHash('sha256').update('cookie-by-id').digest('hex'),
      region: s.org.dataRegion,
    });
    expect((await findValidAuthSessionById(db, row.id))?.user.id).toBe(s.user.id);
    await revokeAuthSession(db, row.id);
    expect(await findValidAuthSessionById(db, row.id)).toBeNull();
  });
});
