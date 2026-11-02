/**
 * Phase F schema (docs/specs/phase-f-contracts.md section 13.2, migration 0009_phase_f) and the section 13.2a repo
 * functions: the new columns default so behaviour is unchanged, the `org_pepper_erased` check, the open-erasure
 * partial unique index, `password_reset.token_hash` uniqueness, the recording source / camera checks and the widened
 * one-per-session rule, the reset and erasure compare-and-sets, the chain digest, and `insertAuditEntry` refusing an
 * erased org.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consumePasswordReset,
  countPasswordResetsSince,
  createOrgWithAdmin,
  createSession,
  deleteStalePasswordResets,
  findPasswordResetByHash,
  getErasure,
  getLatestErasure,
  getOpenErasure,
  getRecordingBySession,
  insertAuditEntry,
  insertErasure,
  insertPasswordReset,
  insertRecording,
  isUniqueViolation,
  listChainDigest,
  listDueErasures,
  markErasureStep,
  org as orgTable,
  OrgErasedError,
  recordingStorageKey,
  seedToken,
  supersedePasswordResets,
  transitionErasure,
  user as userTable,
  type Db,
  type SeededOrg,
  type SessionRow,
} from '../src/index.js';
import { closeDb, freshDb, rejectionText } from './helpers.js';

const H = (c: string) => c.repeat(64);

describe('phase F schema', () => {
  let db: Db;
  let a: SeededOrg;
  let b: SeededOrg;
  let sess: SessionRow;

  beforeAll(async () => {
    db = await freshDb();
    a = await createOrgWithAdmin(db, { planTier: 'p3_portable', seatTier: 'p3_portable', withSignupAudit: true });
    b = await createOrgWithAdmin(db, { withSignupAudit: true });
    const tok = await seedToken(db, a.org, a.user, { tier: 'p3_portable' });
    sess = await createSession(db, {
      orgId: a.org.id,
      tokenId: tok.id,
      assistUserId: a.user.id,
      deskRef: randomUUID(),
      tier: 'p3_portable',
      region: a.org.dataRegion,
      nodeId: 'n1',
    });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('new org and user columns default so behaviour is unchanged', async () => {
    expect(a.org.erasingAt).toBeNull();
    expect(a.org.erasedAt).toBeNull();
    expect(a.org.auditPepper).toMatch(/^[0-9a-f]{64}$/);
    expect(a.user.inviteMailedAt).toBeNull();
    expect(a.user.roleGrantedBy).toBeNull();
    expect(a.user.roleSince).toBeInstanceOf(Date);
  });

  it('org_pepper_erased: a null pepper exactly when erased_at is set', async () => {
    expect(await rejectionText(db.update(orgTable).set({ auditPepper: null }).where(eq(orgTable.id, b.org.id)))).toMatch(
      /org_pepper_erased/,
    );
    expect(await rejectionText(db.update(orgTable).set({ erasedAt: new Date() }).where(eq(orgTable.id, b.org.id)))).toMatch(
      /org_pepper_erased/,
    );
  });

  it('role_granted_by references a user of the region', async () => {
    await db.update(userTable).set({ roleGrantedBy: b.user.id }).where(eq(userTable.id, a.user.id));
    expect(await rejectionText(db.update(userTable).set({ roleGrantedBy: randomUUID() }).where(eq(userTable.id, a.user.id)))).toMatch(
      /role_granted_by/,
    );
    await db.update(userTable).set({ roleGrantedBy: null }).where(eq(userTable.id, a.user.id));
  });

  it('password_reset: unique hash, single-use compare-and-set, supersede, count, stale delete', async () => {
    const now = new Date();
    const r1 = await insertPasswordReset(db, { userId: a.user.id, tokenHash: H('1'), expiresAt: new Date(now.getTime() + 30 * 60_000) });
    await expect(insertPasswordReset(db, { userId: a.user.id, tokenHash: H('1'), expiresAt: now })).rejects.toSatisfy((e) =>
      isUniqueViolation(e, 'password_reset_token_hash_unique'),
    );
    expect((await findPasswordResetByHash(db, H('1')))?.id).toBe(r1.id);
    expect(await findPasswordResetByHash(db, H('9'))).toBeNull();
    expect(await consumePasswordReset(db, r1.id)).toBe(true);
    expect(await consumePasswordReset(db, r1.id)).toBe(false);
    const expired = await insertPasswordReset(db, { userId: a.user.id, tokenHash: H('2'), expiresAt: new Date(now.getTime() - 1000) });
    expect(await consumePasswordReset(db, expired.id)).toBe(false);
    await insertPasswordReset(db, { userId: a.user.id, tokenHash: H('3'), expiresAt: new Date(now.getTime() + 60_000) });
    expect(await supersedePasswordResets(db, a.user.id)).toBe(2);
    expect((await findPasswordResetByHash(db, H('3')))?.superseded).toBe(true);
    expect(await countPasswordResetsSince(db, a.user.id, new Date(now.getTime() - 60_000))).toBe(3);
    expect(await deleteStalePasswordResets(db, new Date(now.getTime() + 3600_000))).toBe(3);
    expect(await countPasswordResetsSince(db, a.user.id, new Date(0))).toBe(0);
  });

  it('org_erasure: one open per org, compare-and-set transitions, due list, step marks', async () => {
    const e1 = await insertErasure(db, { orgId: a.org.id, state: 'pending_approval', requestedBy: a.user.id });
    await expect(insertErasure(db, { orgId: a.org.id, state: 'pending_confirmation', requestedBy: a.user.id, solo: true })).rejects.toSatisfy(
      (e) => isUniqueViolation(e, 'org_erasure_open_unique'),
    );
    expect((await getOpenErasure(db, a.org.id))?.id).toBe(e1.id);
    expect(await getOpenErasure(db, b.org.id)).toBeNull();
    const past = new Date(Date.now() - 1000);
    const cooled = await transitionErasure(db, e1.id, 'pending_approval', 'cooling_off', {
      approvedBy: a.user.id,
      approvedAt: past,
      coolingOffUntil: past,
    });
    expect(cooled?.state).toBe('cooling_off');
    expect(await transitionErasure(db, e1.id, 'pending_approval', 'cancelled')).toBeNull();
    expect((await listDueErasures(db, new Date())).map((e) => e.id)).toContain(e1.id);
    expect((await listDueErasures(db, new Date(past.getTime() - 60_000))).map((e) => e.id)).not.toContain(e1.id);
    await markErasureStep(db, e1.id, 'freeze');
    await markErasureStep(db, e1.id, 'stop');
    const marked = await getErasure(db, e1.id);
    expect(Object.keys(marked!.progress).sort()).toEqual(['freeze', 'stop']);
    const done = await transitionErasure(db, e1.id, ['cooling_off', 'pending_approval'], 'cancelled', { cancelledBy: a.user.id, cancelledAt: new Date() });
    expect(done?.state).toBe('cancelled');
    // A terminal erasure frees the slot for a new attempt.
    const e2 = await insertErasure(db, { orgId: a.org.id, state: 'pending_approval', requestedBy: a.user.id });
    expect((await getLatestErasure(db, a.org.id))?.id).toBe(e2.id);
    await transitionErasure(db, e2.id, 'pending_approval', 'expired');
  });

  it('recording: Desk rows default to source desk; one camera recording per camera; checks', async () => {
    const key = (id: string) => recordingStorageKey(a.org.dataRegion, a.org.id, sess.id, id);
    const desk = await insertRecording(db, { orgId: a.org.id, sessionId: sess.id, uploadedBy: a.user.id, storageKey: key(randomUUID()), region: a.org.dataRegion });
    expect(desk.source).toBe('desk');
    expect(desk.cameraId).toBeNull();
    await expect(
      insertRecording(db, { orgId: a.org.id, sessionId: sess.id, uploadedBy: a.user.id, storageKey: key(randomUUID()), region: a.org.dataRegion }),
    ).rejects.toSatisfy((e) => isUniqueViolation(e, 'recording_session_source_unique'));
    const cameraId = randomUUID();
    const cam = await insertRecording(db, {
      orgId: a.org.id,
      sessionId: sess.id,
      uploadedBy: a.user.id,
      storageKey: key(randomUUID()),
      region: a.org.dataRegion,
      cameraId,
    });
    expect(cam.source).toBe('camera');
    expect((await getRecordingBySession(db, sess.id))?.id).toBe(desk.id);
    expect(await rejectionText(db.execute(sql`update recording set camera_id = null where id = ${cam.id}`))).toMatch(/recording_camera_id_present/);
    expect(await rejectionText(db.execute(sql`update recording set source = 'phone' where id = ${desk.id}`))).toMatch(/recording_source_check/);
  });

  it('listChainDigest pages seq, hash and prevHash in order', async () => {
    await insertAuditEntry(db, {
      orgId: b.org.id,
      actor: { type: 'system', id: null, label: 'system' },
      action: 'org.erasure_started',
      region: b.org.dataRegion,
      data: { erasureId: randomUUID() },
    });
    const all = await listChainDigest(db, b.org.id, 0, 10);
    expect(all.map((e) => e.seq)).toEqual([1, 2]);
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect(await listChainDigest(db, b.org.id, 1, 10)).toHaveLength(1);
    expect(await listChainDigest(db, b.org.id, 0, 1)).toHaveLength(1);
  });

  it('insertAuditEntry refuses an erased org', async () => {
    await db.update(orgTable).set({ auditPepper: null, erasedAt: new Date() }).where(eq(orgTable.id, b.org.id));
    await expect(
      insertAuditEntry(db, {
        orgId: b.org.id,
        actor: { type: 'system', id: null, label: 'system' },
        action: 'org.erasure_expired',
        region: b.org.dataRegion,
        data: { erasureId: randomUUID() },
      }),
    ).rejects.toBeInstanceOf(OrgErasedError);
    // Another org is unaffected.
    const row = await insertAuditEntry(db, {
      orgId: a.org.id,
      actor: { type: 'system', id: null, label: 'system' },
      action: 'org.erasure_expired',
      region: a.org.dataRegion,
      data: { erasureId: randomUUID() },
    });
    expect(row.seq).toBeGreaterThan(1);
  });
});
