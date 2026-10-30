/** Phase C schema (docs/specs/phase-c-contracts.md section 13.2): migration 0005, playbooks, runs, hand-overs. */
import { sha256Hex } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearSessionHandover,
  completePlaybookRun,
  countAgentSessionsSince,
  countElevationGrantsSince,
  countHandoversSince,
  countPlaybookRunsSince,
  createOrgWithAdmin,
  deletePlaybook,
  getPlaybookRun,
  getPlaybookScoped,
  getSession,
  insertHandover,
  insertPlaybook,
  insertPlaybookRun,
  listExpiredHandoverSessions,
  listManifestPlaybooks,
  listPlaybooksByOrg,
  PlaybookNameTakenError,
  seedSession,
  seedToken,
  settleHandover,
  transitionSession,
  updateOrg,
  updatePlaybook,
  updateSession,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb } from './helpers.js';

const OP = '0123456789abcdef';

describe('phase C schema', () => {
  let db: Db;
  let a: SeededOrg;
  let b: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    a = await createOrgWithAdmin(db, { planTier: 'p3_portable', seatTier: 'p3_portable' });
    b = await createOrgWithAdmin(db, { planTier: 'p3_portable', seatTier: 'p3_portable' });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('org.require_sas_confirm defaults to true and is patchable', async () => {
    expect(a.org.requireSasConfirm).toBe(true);
    expect((await updateOrg(db, a.org.id, { requireSasConfirm: false })).requireSasConfirm).toBe(false);
    await updateOrg(db, a.org.id, { requireSasConfirm: true });
  });

  it('playbooks: server hash, (org, name) unique, scoped loads, cursor scoping, manifest filter', async () => {
    const p = await insertPlaybook(db, { orgId: a.org.id, name: 'Flush DNS', description: '', interpreter: 'cmd', body: 'ipconfig /flushdns', createdBy: a.user.id });
    expect(p.bodySha256).toBe(sha256Hex('ipconfig /flushdns'));
    expect(p.timeoutSec).toBe(120);
    await expect(insertPlaybook(db, { orgId: a.org.id, name: 'Flush DNS', description: '', interpreter: 'cmd', body: 'x', createdBy: null })).rejects.toBeInstanceOf(PlaybookNameTakenError);
    await insertPlaybook(db, { orgId: b.org.id, name: 'Flush DNS', description: '', interpreter: 'cmd', body: 'x', createdBy: null });
    expect(await getPlaybookScoped(db, p.id, b.org.id)).toBeNull();
    expect(await getPlaybookScoped(db, 'not-a-uuid', a.org.id)).toBeNull();
    const ps = await insertPlaybook(db, { orgId: a.org.id, name: 'Clear temp', description: 'd', interpreter: 'powershell', body: 'Remove-Item $env:TEMP\\* -Recurse', createdBy: a.user.id });
    const sh = await insertPlaybook(db, { orgId: a.org.id, name: 'Shell', description: '', interpreter: 'sh', body: 'ls', createdBy: null });
    const page1 = await listPlaybooksByOrg(db, a.org.id, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    const page2 = await listPlaybooksByOrg(db, a.org.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.every((r) => r.orgId === a.org.id)).toBe(true);
    expect([...page1.items, ...page2.items].map((r) => r.id).sort()).toEqual([p.id, ps.id, sh.id].sort());
    const upd = await updatePlaybook(db, ps.id, a.org.id, { body: 'Get-Date', enabled: false });
    expect(upd?.bodySha256).toBe(sha256Hex('Get-Date'));
    expect(await updatePlaybook(db, ps.id, b.org.id, { enabled: true })).toBeNull();
    const manifest = await listManifestPlaybooks(db, a.org.id, ['powershell', 'cmd'], 100);
    expect(manifest.map((r) => r.id)).toEqual([p.id]);
    expect(await deletePlaybook(db, sh.id, b.org.id)).toBe(false);
    expect(await deletePlaybook(db, sh.id, a.org.id)).toBe(true);
  });

  it('session columns round-trip; consent_level holds the P3 values', async () => {
    const tok = await seedToken(db, a.org, a.user, { tier: 'p3_portable' });
    const s = await seedSession(db, tok);
    await transitionSession(db, s.id, 'accepted');
    await transitionSession(db, s.id, 'consent_pending');
    await transitionSession(db, s.id, 'active', { set: { consentSurface: 'monitor', consentLevel: 'control', consentMonitors: 2, consentClipboard: false } });
    const exp = new Date(Date.now() - 1000);
    await updateSession(db, s.id, { consentLevel: 'elevated', elevation: 'admin', handoverHash: 'a'.repeat(64), handoverOpid: OP, handoverExpiresAt: exp });
    const got = (await getSession(db, s.id))!;
    expect([got.consentLevel, got.consentMonitors, got.consentClipboard, got.elevation, got.handoverOpid]).toEqual(['elevated', 2, false, 'admin', OP]);
    expect((await listExpiredHandoverSessions(db)).map((r) => r.id)).toContain(s.id);
    expect(await clearSessionHandover(db, s.id, 'b'.repeat(64))).toBeNull();
    expect((await clearSessionHandover(db, s.id, 'a'.repeat(64)))?.handoverHash).toBeNull();
    expect((await listExpiredHandoverSessions(db)).map((r) => r.id)).not.toContain(s.id);
    expect(await countAgentSessionsSince(db, a.org.id, new Date(Date.now() - 86400_000))).toBeGreaterThanOrEqual(1);
  });

  it('hand-over log: settle once, counts; playbook runs complete once', async () => {
    const tok = await seedToken(db, a.org, a.user, { tier: 'p3_portable' });
    const s = await seedSession(db, tok);
    const h = sha256Hex('handover-1');
    await insertHandover(db, { sessionId: s.id, orgId: a.org.id, tokenHash: h, opId: OP, expiresAt: new Date(Date.now() + 120_000) });
    expect(await countHandoversSince(db, s.id, new Date(Date.now() - 600_000))).toBe(1);
    expect(await settleHandover(db, h, 'claimed')).toBe(true);
    expect(await settleHandover(db, h, 'expired')).toBe(false);
    expect(await countElevationGrantsSince(db, a.org.id, new Date(Date.now() - 86400_000))).toBe(1);
    const runId = 'c'.repeat(32);
    await insertPlaybookRun(db, { runId, sessionId: s.id, orgId: a.org.id, playbookId: s.id, bodySha256: h, opId: OP, requestedBy: a.user.id });
    expect(await completePlaybookRun(db, s.id, runId, { exitCode: 0, durationMs: 5, ranAs: 'user', error: null })).toBe(true);
    expect(await completePlaybookRun(db, s.id, runId, { exitCode: 1, durationMs: 5, ranAs: 'user', error: null })).toBe(false);
    expect((await getPlaybookRun(db, s.id, runId))?.exitCode).toBe(0);
    expect(await countPlaybookRunsSince(db, a.org.id, new Date(Date.now() - 86400_000))).toBe(1);
  });
});
