import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addParticipant,
  canTransition,
  closeAllParticipants,
  createOrgUser,
  createOrgWithAdmin,
  endSession,
  findOpenSessionByToken,
  getSession,
  InvalidSessionTransitionError,
  listOpenSessionsByNode,
  listParticipants,
  listSessionFiles,
  listSessionsByOrg,
  listSessionsPastDeadline,
  markRecordingStarted,
  NotFoundError,
  replaceParticipant,
  SESSION_TRANSITIONS,
  SessionAlreadyEndedError,
  seedSession,
  seedToken,
  sessionFileMatch,
  transitionSession,
  updateSession,
  upsertSessionFile,
  insertAuditEntry,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb } from './helpers.js';

describe('session state machine', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db);
  });
  afterAll(async () => {
    await closeDb(db);
  });

  const newSession = async () => seedSession(db, await seedToken(db, s.org, s.user));

  it('encodes section 7.4 edges', () => {
    expect(canTransition('knocked', 'accepted')).toBe(true);
    expect(canTransition('knocked', 'active')).toBe(false);
    expect(canTransition('active', 'consent_pending')).toBe(true);
    expect(canTransition('ended', 'knocked')).toBe(false);
    expect(SESSION_TRANSITIONS.ended).toEqual([]);
  });

  it('walks knocked -> accepted -> consent_pending -> active -> ended with side effects', async () => {
    const created = await newSession();
    expect(created.state).toBe('knocked');
    expect(created.knockExpiresAt!.getTime() - created.knockedAt.getTime()).toBe(120_000);

    const { user: senior } = await createOrgUser(db, s.org, { role: 'senior_technician' });
    const t0 = new Date('2026-10-23T10:00:00.000Z');
    const accepted = await transitionSession(db, created.id, 'accepted', { now: t0, set: { assistUserId: senior.id } });
    expect(accepted).toMatchObject({ state: 'accepted', assistUserId: senior.id, knockExpiresAt: null });
    expect(accepted.acceptedAt?.toISOString()).toBe(t0.toISOString());

    const pending = await transitionSession(db, created.id, 'consent_pending', { now: t0 });
    expect(pending.consentState).toBe('pending');
    expect(pending.consentDeadlineAt!.getTime() - t0.getTime()).toBe(180_000);

    const t1 = new Date('2026-10-23T10:01:00.000Z');
    const active = await transitionSession(db, created.id, 'active', { now: t1, set: { consentSurface: 'monitor' } });
    expect(active).toMatchObject({
      state: 'active',
      consentState: 'granted',
      consentSurface: 'monitor',
      consentDeadlineAt: null,
    });
    expect(active.startedAt?.toISOString()).toBe(t1.toISOString());

    // Desk resume: active -> consent_pending -> active keeps the first started_at
    await transitionSession(db, created.id, 'consent_pending', { from: 'active' });
    const again = await transitionSession(db, created.id, 'active', { now: new Date('2026-10-23T10:05:00.000Z') });
    expect(again.startedAt?.toISOString()).toBe(t1.toISOString());

    const ended = await endSession(db, created.id, 'assist_ended');
    expect(ended).toMatchObject({ state: 'ended', endReason: 'assist_ended' });
    expect(ended.endedAt).toBeInstanceOf(Date);
  });

  it('rejects edges the machine does not allow', async () => {
    const sess = await newSession();
    const err = await transitionSession(db, sess.id, 'active').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSessionTransitionError);
    expect(err).toMatchObject({ from: 'knocked', to: 'active', code: 'invalid_transition' });
    await expect(transitionSession(db, sess.id, 'consent_pending')).rejects.toBeInstanceOf(
      InvalidSessionTransitionError,
    );
    await expect(transitionSession(db, sess.id, 'knocked')).rejects.toBeInstanceOf(InvalidSessionTransitionError);
    // a requested source that cannot reach the target is a programming error, caught before SQL
    await expect(transitionSession(db, sess.id, 'active', { from: 'knocked' })).rejects.toMatchObject({
      from: 'knocked',
    });
    // a valid edge whose source no longer matches the row
    await expect(
      transitionSession(db, sess.id, 'ended', { from: 'active', set: { endReason: 'error' } }),
    ).rejects.toMatchObject({
      from: 'knocked',
      to: 'ended',
    });
    expect((await getSession(db, sess.id))?.state).toBe('knocked');
  });

  it('treats ended as terminal (already_ended) and lets exactly one concurrent ender win', async () => {
    const sess = await newSession();
    const results = await Promise.allSettled([
      endSession(db, sess.id, 'timeout'),
      endSession(db, sess.id, 'denied'),
      endSession(db, sess.id, 'error'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SessionAlreadyEndedError);
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'already_ended' });
    }
    await expect(transitionSession(db, sess.id, 'accepted')).rejects.toBeInstanceOf(SessionAlreadyEndedError);
  });

  it('sets consent_state revoked on consent_revoked and requires an end reason', async () => {
    const sess = await newSession();
    await expect(transitionSession(db, sess.id, 'ended')).rejects.toThrow(/endReason/);
    await expect(transitionSession(db, sess.id, 'accepted', { set: { endReason: 'error' } })).rejects.toThrow(
      /endReason/,
    );
    const ended = await endSession(db, sess.id, 'consent_revoked');
    expect(ended.consentState).toBe('revoked');
  });

  it('reports unknown sessions as not found and blocks state writes through updateSession', async () => {
    await expect(transitionSession(db, '00000000-0000-4000-8000-000000000000', 'accepted')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const sess = await newSession();
    await expect(updateSession(db, sess.id, { state: 'active' } as never)).rejects.toThrow(/not patchable/);
    const updated = await updateSession(db, sess.id, { path: 'relay', lastStats: { rttMs: 40 } });
    expect(updated).toMatchObject({ path: 'relay', lastStats: { rttMs: 40 } });
    expect(await markRecordingStarted(db, sess.id)).toBe(true);
    expect(await markRecordingStarted(db, sess.id)).toBe(false);
  });

  it('finds open sessions by token and node, and past-deadline knocks', async () => {
    const tok = await seedToken(db, s.org, s.user);
    const sess = await seedSession(db, tok, { nodeId: 'node-x' });
    expect((await findOpenSessionByToken(db, tok.id))?.id).toBe(sess.id);
    expect((await listOpenSessionsByNode(db, 'node-x')).map((r) => r.id)).toEqual([sess.id]);
    const later = new Date(Date.now() + 121_000);
    expect((await listSessionsPastDeadline(db, later)).map((r) => r.id)).toContain(sess.id);
    await endSession(db, sess.id, 'timeout');
    expect(await findOpenSessionByToken(db, tok.id)).toBeNull();
    expect(await listOpenSessionsByNode(db, 'node-x')).toEqual([]);
  });
});

describe('session lists, participants and files', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db);
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('lists newest first with cursor pages and the own scope', async () => {
    const { user: tech } = await createOrgUser(db, s.org, { role: 'technician' });
    const { user: other } = await createOrgUser(db, s.org, { role: 'technician' });
    const techTok = await seedToken(db, s.org, tech);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await seedSession(db, await seedToken(db, s.org, s.user))).id);
    const onTechToken = await seedSession(db, techTok, { assistUserId: other.id });
    const acceptedByTech = await seedSession(db, await seedToken(db, s.org, other), { assistUserId: tech.id });

    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listSessionsByOrg(db, s.org.id, { limit: 2, cursor });
      all.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
    expect(all.slice(-5)).toEqual([...ids].reverse());

    const own = await listSessionsByOrg(db, s.org.id, { ownUserId: tech.id });
    expect(own.items.map((r) => r.id).sort()).toEqual([onTechToken.id, acceptedByTech.id].sort());
    expect((await listSessionsByOrg(db, s.org.id, { state: 'ended' })).items).toEqual([]);
  });

  it('replaces participant rows on resume and closes them on end', async () => {
    const sess = await seedSession(db, await seedToken(db, s.org, s.user));
    await addParticipant(db, {
      sessionId: sess.id,
      role: 'assist',
      userId: s.user.id,
      label: s.user.name,
      connectionId: 'c1',
    });
    await addParticipant(db, { sessionId: sess.id, role: 'desk', label: 'Desk', connectionId: 'd1' });
    await replaceParticipant(db, { sessionId: sess.id, role: 'desk', label: 'Desk', connectionId: 'd2' });
    let rows = await listParticipants(db, sess.id);
    expect(rows.map((r) => [r.role, r.connectionId, r.leftAt === null])).toEqual([
      ['assist', 'c1', true],
      ['desk', 'd1', false],
      ['desk', 'd2', true],
    ]);
    expect(await closeAllParticipants(db, sess.id)).toBe(2);
    rows = await listParticipants(db, sess.id);
    expect(rows.every((r) => r.leftAt !== null)).toBe(true);
  });

  it('upserts file attestations from both sides', async () => {
    const sess = await seedSession(db, await seedToken(db, s.org, s.user));
    const entry = (side: 'assist' | 'desk') =>
      insertAuditEntry(db, {
        orgId: s.org.id,
        sessionId: sess.id,
        actor:
          side === 'assist'
            ? { type: 'user', id: s.user.id, label: s.user.name }
            : { type: 'desk', id: sess.deskRef, label: 'desk:x' },
        action: side === 'assist' ? 'file.sent' : 'file.received',
        region: s.org.dataRegion,
        data: { fileId: 1, direction: 'assist_to_desk', nameHash: 'a'.repeat(64), bytes: 10, sha256: 'b'.repeat(64) },
      });
    const e1 = await entry('assist');
    const base = { sessionId: sess.id, direction: 'assist_to_desk' as const, fileId: 1, name: 'report.pdf', bytes: 10 };
    let row = await upsertSessionFile(db, { ...base, sha256: 'b'.repeat(64), side: 'assist', entryId: e1.id });
    expect(sessionFileMatch(row)).toBeNull();
    const e2 = await entry('desk');
    row = await upsertSessionFile(db, { ...base, sha256: 'c'.repeat(64), side: 'desk', entryId: e2.id });
    expect(row).toMatchObject({ assistEntryId: e1.id, deskEntryId: e2.id });
    expect(sessionFileMatch(row)).toBe(false);
    expect(await listSessionFiles(db, sess.id)).toHaveLength(1);
  });
});
