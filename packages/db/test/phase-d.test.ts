/**
 * Phase D schema (docs/specs/phase-d-contracts.md section 13.2, migration 0007_phase_d): extended enums, device /
 * device_group / device_action / wake_attempt / amt_sol round-trips, a token-less P4 session passing the CHECK, the
 * device-open unique index, the enrollment counter and the org fleet columns.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_UNATTENDED_POLICY } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAmtSol,
  countEnrollment,
  createOrgWithAdmin,
  createSession,
  deleteDeviceGroup,
  DeviceGroupNameTakenError,
  endSession,
  expireDeviceActions,
  findEnrolledByFingerprint,
  findOpenSessionByDevice,
  getDevice,
  getDeviceGroupScoped,
  getDeviceScoped,
  insertAmtSol,
  insertDevice,
  insertDeviceAction,
  insertDeviceGroup,
  insertWakeAttempt,
  listDevicesByOrg,
  listQueuedActions,
  lockToken,
  seedToken,
  setDeviceStatus,
  transitionDeviceAction,
  transitionWakeAttempt,
  updateOrg,
  updateUser,
  type Db,
  type DeviceRow,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb, rejectionText } from './helpers.js';

const H = 'a'.repeat(64);

describe('phase D schema', () => {
  let db: Db;
  let a: SeededOrg;
  let b: SeededOrg;
  let dev: DeviceRow;
  beforeAll(async () => {
    db = await freshDb();
    a = await createOrgWithAdmin(db, { planTier: 'p4_installed', seatTier: 'p4_installed' });
    b = await createOrgWithAdmin(db, { planTier: 'p4_installed', seatTier: 'p4_installed' });
    dev = await insertDevice(db, {
      orgId: a.org.id,
      name: 'PC-01',
      region: a.org.dataRegion,
      publicKey: 'A'.repeat(43),
      keyId: '0123456789abcdef',
      kexPublicKey: 'B'.repeat(43),
      hwFingerprint: H,
      capabilities: { monitors: 1 },
      enrolledAt: new Date(),
    });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('org fleet columns default (waker mesh on, scoping off, the safe unattended policy)', async () => {
    expect(a.org.wakerMeshEnabled).toBe(true);
    expect(a.org.fleetScopingEnabled).toBe(false);
    expect(a.org.unattendedPolicy).toEqual(DEFAULT_UNATTENDED_POLICY);
    const o = await updateOrg(db, a.org.id, { fleetScopingEnabled: true, unattendedPolicy: { ...DEFAULT_UNATTENDED_POLICY, mode: 'allow' } });
    expect(o.fleetScopingEnabled).toBe(true);
    expect((o.unattendedPolicy as { mode: string }).mode).toBe('allow');
    expect((await updateUser(db, a.user.id, { deviceGroupIds: [] })).deviceGroupIds).toEqual([]);
  });

  it('device defaults, scoped loads and the fingerprint lookup', async () => {
    expect(dev.platform).toBe('windows');
    expect(dev.tamperState).toBe('ok');
    expect(dev.status).toBe('enrolled');
    expect(await getDeviceScoped(db, dev.id, b.org.id)).toBeNull();
    expect((await getDeviceScoped(db, dev.id, a.org.id))?.id).toBe(dev.id);
    expect((await findEnrolledByFingerprint(db, a.org.id, H))?.id).toBe(dev.id);
    expect(await findEnrolledByFingerprint(db, b.org.id, H)).toBeNull();
  });

  it('device_status, actor_type and session_end_reason carry the Phase D values', async () => {
    const d2 = await insertDevice(db, { orgId: a.org.id, name: 'PC-02', region: a.org.dataRegion });
    for (const s of ['superseded', 'retired', 'deregistered'] as const) {
      const r = await setDeviceStatus(db, d2.id, s, ['enrolled', 'disabled', 'superseded', 'retired', 'deregistered']);
      expect(r?.status).toBe(s);
    }
    expect(await setDeviceStatus(db, d2.id, 'enrolled', ['disabled'])).toBeNull();
  });

  it('device groups: (org, name) unique, delete falls devices back to the org default', async () => {
    const g = await insertDeviceGroup(db, { orgId: a.org.id, name: 'Finance', defaultPolicy: { mode: 'allow' }, createdBy: a.user.id });
    expect(g.defaultTags).toEqual([]);
    await expect(insertDeviceGroup(db, { orgId: a.org.id, name: 'Finance', createdBy: a.user.id })).rejects.toBeInstanceOf(DeviceGroupNameTakenError);
    expect(await getDeviceGroupScoped(db, g.id, b.org.id)).toBeNull();
    const d3 = await insertDevice(db, { orgId: a.org.id, name: 'PC-03', region: a.org.dataRegion, groupId: g.id });
    expect((await listDevicesByOrg(db, a.org.id, { groupId: g.id })).items.map((d) => d.id)).toEqual([d3.id]);
    expect((await listDevicesByOrg(db, a.org.id, { groupIds: [] })).items).toEqual([]);
    expect(await deleteDeviceGroup(db, g.id, a.org.id)).toBe(true);
    expect((await getDevice(db, d3.id))?.groupId).toBeNull();
  });

  it('a token-less P4 session passes the CHECK; the device-open unique index rejects a second open session', async () => {
    const base = { orgId: a.org.id, assistUserId: a.user.id, deskRef: randomUUID(), tier: 'p4_installed' as const, region: a.org.dataRegion, nodeId: 'n1' };
    const s = await createSession(db, { ...base, deviceId: dev.id, unattended: true, unattendedPolicy: { ...DEFAULT_UNATTENDED_POLICY } });
    expect(s.tokenId).toBeNull();
    expect(s.deviceId).toBe(dev.id);
    expect((await findOpenSessionByDevice(db, dev.id))?.id).toBe(s.id);
    expect(await rejectionText(createSession(db, { ...base, deskRef: randomUUID(), deviceId: dev.id }))).toContain('session_device_open_unique');
    expect(await rejectionText(createSession(db, { ...base, deskRef: randomUUID() }))).toContain('session_token_or_device');
    await endSession(db, s.id, 'device_disabled');
    expect(await findOpenSessionByDevice(db, dev.id)).toBeNull();
    const again = await createSession(db, { ...base, deskRef: randomUUID(), deviceId: dev.id });
    await endSession(db, again.id, 'consent_required');
  });

  it('an enrollment token counts devices under its row lock and goes used at max_devices', async () => {
    const tok = await seedToken(db, a.org, a.user, { tier: 'p4_installed', typ: 'enrollment' });
    expect(tok.maxDevices).toBe(1);
    expect(tok.devicesEnrolled).toBe(0);
    const after = await db.transaction(async (tx) => countEnrollment(tx, (await lockToken(tx, tok.id))!));
    expect(after?.devicesEnrolled).toBe(1);
    expect(after?.status).toBe('used');
    expect(await db.transaction(async (tx) => countEnrollment(tx, (await lockToken(tx, tok.id))!))).toBeNull();
  });

  it('device actions: queue order, conditional transitions, expiry sweep', async () => {
    const x = await insertDeviceAction(db, { orgId: a.org.id, deviceId: dev.id, createdBy: a.user.id, kind: 'message', payload: { title: 't', body: 'b' } });
    const y = await insertDeviceAction(db, {
      orgId: a.org.id,
      deviceId: dev.id,
      createdBy: a.user.id,
      kind: 'file_push',
      payload: {},
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(x.state).toBe('queued');
    expect((await listQueuedActions(db, dev.id)).map((r) => r.id)).toEqual([x.id]);
    expect((await transitionDeviceAction(db, x.id, 'dispatched', ['queued'], { dispatchedAt: new Date() }))?.state).toBe('dispatched');
    expect(await transitionDeviceAction(db, x.id, 'dispatched', ['queued'])).toBeNull();
    expect((await transitionDeviceAction(db, x.id, 'done', ['dispatched', 'running'], { approvedBy: 'policy', result: { exit: 0 } }))?.approvedBy).toBe('policy');
    expect((await expireDeviceActions(db)).map((r) => r.id)).toContain(y.id);
  });

  it('wake attempts and AMT SOL round-trip', async () => {
    const w = await insertWakeAttempt(db, { orgId: a.org.id, deviceId: dev.id, createdBy: a.user.id, method: 'wol' });
    expect(w.state).toBe('pending');
    expect((await transitionWakeAttempt(db, w.id, 'failed', ['pending'], { cause: 'no_waker' }))?.cause).toBe('no_waker');
    const sol = await insertAmtSol(db, { orgId: a.org.id, deviceId: dev.id, openedBy: a.user.id, viaDeviceId: dev.id, reason: 'bios' });
    expect((await closeAmtSol(db, sol.id, { transcriptSha256: H }))?.transcriptSha256).toBe(H);
    expect(await closeAmtSol(db, sol.id)).toBeNull();
  });
});
