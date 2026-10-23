/** Phase B schema (docs/specs/phase-b-contracts.md section 11.1): migration 0003, consent columns, session_host, retention. */
import { pepperedHash } from '@indiansassist/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrgWithAdmin,
  deleteSessionHosts,
  getOrg,
  getSession,
  insertAuditEntry,
  insertRecording,
  listRecordingsPastRetention,
  markRecordingDeleted,
  markRecordingStored,
  queryRows,
  recording,
  recordingStorageKey,
  recordingUsage,
  seedSession,
  seedToken,
  sessionHostMap,
  transitionSession,
  updateOrg,
  updateSession,
  upsertSessionHost,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb, rejectionText } from './helpers.js';

const OP = '0123456789abcdef';

describe('phase B schema', () => {
  let db: Db;
  let s: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    s = await createOrgWithAdmin(db, { planTier: 'p2_extension', seatTier: 'p2_extension' });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  const p2Session = async () => seedSession(db, await seedToken(db, s.org, s.user, { tier: 'p2_extension', typ: 'timed' }));

  it('org.extension_policy defaults to {} and retention days are range-checked', async () => {
    expect(s.org.extensionPolicy).toEqual({});
    expect(s.org.recordingRetentionDays).toBeNull();
    const o = await updateOrg(db, s.org.id, { extensionPolicy: { allowAllTabs: false }, recordingRetentionDays: 30 });
    expect(o.extensionPolicy).toEqual({ allowAllTabs: false });
    expect(o.recordingRetentionDays).toBe(30);
    expect(await rejectionText(updateOrg(db, s.org.id, { recordingRetentionDays: 0 }))).toMatch(/retention/);
    expect(await rejectionText(updateOrg(db, s.org.id, { recordingRetentionDays: 3651 }))).toMatch(/retention/);
    await updateOrg(db, s.org.id, { recordingRetentionDays: null });
  });

  it('session consent level, scope, backstage and desk_client round trip', async () => {
    const row = await p2Session();
    expect(row.consentLevel).toBeNull();
    await transitionSession(db, row.id, 'accepted');
    await transitionSession(db, row.id, 'consent_pending');
    const active = await transitionSession(db, row.id, 'active', {
      set: { consentSurface: 'browser', consentLevel: 'tab_control', consentScope: 'current_tab', consentBackstage: false },
    });
    expect(active).toMatchObject({ consentLevel: 'tab_control', consentScope: 'current_tab', consentBackstage: false });
    const client = { kind: 'extension', version: '0.2.0', browser: { name: 'chrome', version: '131' } };
    await updateSession(db, row.id, { consentLevel: 'deep_control', consentBackstage: true, deskClient: client });
    expect(await getSession(db, row.id)).toMatchObject({ consentLevel: 'deep_control', consentBackstage: true, deskClient: client });
    await expect(db.execute(sql`update session set consent_level = 'root' where id = ${row.id}`)).rejects.toThrow();
  });

  it('session_host is unique per (session, hostHash) and deletable', async () => {
    const row = await p2Session();
    const hostHash = pepperedHash(s.org.auditPepper, 'example.com');
    await upsertSessionHost(db, { sessionId: row.id, orgId: s.org.id, hostHash, host: 'example.com' });
    await upsertSessionHost(db, { sessionId: row.id, orgId: s.org.id, hostHash, host: 'example.com' });
    expect(await sessionHostMap(db, row.id)).toEqual({ [hostHash]: 'example.com' });
    await expect(db.execute(sql`insert into session_host (session_id, org_id, host_hash, host) values (${row.id}, ${s.org.id}, ${hostHash}, 'x')`)).rejects.toThrow();
    await expect(upsertSessionHost(db, { sessionId: row.id, orgId: s.org.id, hostHash: 'nothex', host: 'x' })).rejects.toThrow(/hostHash/);
    expect(await deleteSessionHosts(db, row.id)).toBe(1);
    expect(await sessionHostMap(db, row.id)).toEqual({});
  });

  it('audit round trip for each new chain action', async () => {
    const row = await p2Session();
    const hh = 'b'.repeat(64);
    const entries: [string, Record<string, unknown>][] = [
      ['mirror.started', { reason: 'consent', scope: 'current_tab', level: 'tab_control', tabCount: 1, tabId: 4 }],
      ['mirror.stopped', { reason: 'ended', batches: 10, bytes: 2048 }],
      ['tab.action', { kind: 'tabs.navigate', opId: OP, tabId: 4, hostHash: hh, ok: true }],
      ['tab.action', { kind: 'tabs.navigate', opId: OP, tabId: 4, hostHash: hh }],
      ['control.input', { mode: 'dom', tabId: 4, count: 3, kinds: ['pointer', 'key'], windowMs: 10000, refused: 0 }],
      ['mask.requested', { tabId: 4, scope: 'field', nodeId: 7, opId: OP }],
      ['mask.override', { tabId: 4, scope: 'field', nodeId: 7, fieldKind: 'input', outline: { w: 200, h: 30 }, opId: OP, ttlMs: 60000 }],
      ['mask.refused', { tabId: 4, scope: 'tab', opId: OP, cause: 'timeout' }],
      ['mask.restored', { tabId: 4, scope: 'field', durationMs: 5000, by: 'blur' }],
      ['level.requested', { level: 'in_page', opId: OP }],
      ['consent.level_refused', { from: 'tab_control', requested: 'deep_control', opId: OP, timeout: true }],
      ['backstage.enter', { tabId: 9, hostHash: hh, opId: OP, ok: true }],
      ['backstage.exit', { tabId: 9, outcome: 'closed', durationMs: 100 }],
      ['consent.level_changed', { from: 'tab_control', to: 'in_page', requestedBy: 'assist', opId: OP }],
      ['consent.backstage_changed', { from: false, to: true }],
      ['mirror.relayed', { mirrorFrames: 3, mirrorBytes: 100, controlFrames: 1, dropped: 0 }],
      ['session.consent_granted', { surface: 'browser', level: 'view', scope: 'all_tabs', backstage: true }],
    ];
    for (const [action, data] of entries) {
      const e = await insertAuditEntry(db, {
        orgId: s.org.id,
        region: s.org.dataRegion,
        sessionId: row.id,
        actor: { type: 'desk', id: row.deskRef, label: 'desk:x' },
        action: action as never,
        data,
      });
      expect(e.data).toEqual(data);
    }
    await expect(
      insertAuditEntry(db, {
        orgId: s.org.id,
        region: s.org.dataRegion,
        sessionId: row.id,
        actor: { type: 'desk', id: row.deskRef, label: 'desk:x' },
        action: 'tab.action',
        data: { kind: 'tabs.navigate', opId: OP, host: 'example.com', ok: true },
      }),
    ).rejects.toThrow();
  });

  it('recording deletion and the retention sweep query', async () => {
    const o = await updateOrg(db, s.org.id, { recordingRetentionDays: 1 });
    const row = await p2Session();
    const rec = await insertRecording(db, {
      orgId: o.id,
      sessionId: row.id,
      uploadedBy: s.user.id,
      storageKey: recordingStorageKey(o.dataRegion, o.id, row.id, 'r1', 'jsonl.gz'),
      region: o.dataRegion,
      mime: 'application/x-ia-rrweb+jsonl',
    });
    expect(rec.storageKey.endsWith('.jsonl.gz')).toBe(true);
    await markRecordingStored(db, rec.id, { sha256: 'c'.repeat(64), bytes: 500, storedAt: new Date(Date.now() - 2 * 86_400_000) });
    expect((await listRecordingsPastRetention(db)).map((r) => r.id)).toContain(rec.id);
    expect((await recordingUsage(db, o.id, s.user.id)).orgBytes).toBeGreaterThanOrEqual(500);
    const del = await markRecordingDeleted(db, rec.id, s.user.id);
    expect(del?.deletedAt).toBeInstanceOf(Date);
    expect(del?.deletedBy).toBe(s.user.id);
    expect(await markRecordingDeleted(db, rec.id, null)).toBeNull();
    expect((await listRecordingsPastRetention(db)).map((r) => r.id)).not.toContain(rec.id);
    const [left] = await db.select().from(recording).where(eq(recording.id, rec.id));
    expect(left?.status).toBe('stored');
    const rows = await queryRows<{ n: number }>(db, sql`select count(*)::int as n from recording where deleted_at is not null`);
    expect(rows[0]!.n).toBe(1);
    expect((await getOrg(db, o.id))?.recordingRetentionDays).toBe(1);
  });
});
