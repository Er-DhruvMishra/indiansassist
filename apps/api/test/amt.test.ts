/**
 * Phase D AMT / vPro out-of-band access, server side (docs/specs/phase-d-contracts.md sections 7.1, 7.2, 8.1, 8.4):
 * `POST /devices/:id/wake { method: 'amt' }` (cold power-on), `POST /devices/:id/amt/sol` and `/amt/boot`. These are
 * the paths where no on-screen indicator can exist, so the gates are the point: senior_technician or org_admin only,
 * a typed reason, the `allowAmtSol` / `allowAmtBootRedirect` flags that default **off**, hardware that must really be
 * present and provisioned with a proxy in its segment, another org's device id answering 404, the credential read
 * from the vault and sealed to the elected proxy for that one command (rule 8.4c), and an audit entry carrying the
 * reason for each.
 */
import { openSealed, type Sealed } from '@indiansassist/shared';
import { listAuditByOrgPaginated, type AuditEntryRow } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, call, listen, type Account, type SignalClient, type TestApp } from './helpers.js';
import { startFakeVault, vaultEnv, type FakeVault } from './fake-vault.js';
import {
  connectDevice,
  deviceGroup,
  enrollDevice,
  makeP4App,
  newDev,
  p4Admin,
  SERVICE_FEATURES_BASE,
  SUBNET,
  type Dev,
} from './p4-kit.js';

const AMT_READY = { present: true, provisioned: true, version: '11.8.50', host: '10.20.30.40', tls: true, powerState: 8 };
const AMT_UNPROVISIONED = { present: true, provisioned: false, version: '11.8.50', tls: false };
const CRED = { user: 'amt-admin', pass: 'n0t-in-any-log' };
const OTHER_SUBNET = 'c'.repeat(64);
const REASON = 'cold boot the till PC for the night patch window';

describe('AMT power-on, SOL console and boot redirect (section 8.4)', () => {
  let t: TestApp;
  let url: string;
  let vault: FakeVault;
  let admin: Account;
  let senior: Account;
  let senior2: Account;
  let tech: Account;
  let auditor: Account;
  let observer: Account;
  /** AMT ready, in the proxy's segment, under a group whose AMT flags are on. */
  let target: Dev;
  /** The elected AMT proxy (`amt_proxy` feature, online, same segment). */
  let proxy: SignalClient;
  let proxyDev: Dev;
  /** AMT flags on, but no AMT firmware at all. */
  let noAmt: Dev;
  /** AMT present but not provisioned. */
  let unprovisioned: Dev;
  /** AMT ready, but alone in its own segment (no proxy). */
  let lonely: Dev;
  /** AMT ready, under a group that leaves the AMT flags at their default (off). */
  let flagsOff: Dev;
  const sockets: SignalClient[] = [];

  const sol = (acc: Account, d: Dev, body: unknown = { reason: REASON }) =>
    call(t.app, `/api/v1/devices/${d.deviceId}/amt/sol`, { cookie: acc.cookie, body });
  const boot = (acc: Account, d: Dev, body: unknown = { target: 'pxe', reason: REASON }) =>
    call(t.app, `/api/v1/devices/${d.deviceId}/amt/boot`, { cookie: acc.cookie, body });
  const wake = (acc: Account, d: Dev, body: unknown = { method: 'amt', reason: REASON }) =>
    call(t.app, `/api/v1/devices/${d.deviceId}/wake`, { cookie: acc.cookie, body });
  const codeOf = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code;
  const auditOf = async (action: string): Promise<AuditEntryRow[]> =>
    (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action, limit: 50 })).items;

  beforeAll(async () => {
    vault = await startFakeVault();
    t = await makeP4App(vaultEnv(vault));
    url = await listen(t.app);
    admin = await p4Admin(t);
    vault.secrets.set(`${admin.org.id}/amt/default`, CRED);
    senior = await addMember(t.app, admin, 'senior_technician');
    senior2 = await addMember(t.app, admin, 'senior_technician');
    tech = await addMember(t.app, admin, 'technician');
    auditor = await addMember(t.app, admin, 'auditor');
    observer = await addMember(t.app, admin, 'observer');
    const amtGroup = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false, allowAmtSol: true, allowAmtBootRedirect: true });
    const plainGroup = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });

    proxyDev = await enrollDevice(t, admin, { groupId: amtGroup, dev: newDev([...SERVICE_FEATURES_BASE, 'amt_proxy']), name: 'PROXY' });
    proxy = await connectDevice(url, proxyDev, { track: sockets, subnetHash: SUBNET });
    await proxy.next('device.hello.ok');

    target = await enrollDevice(t, admin, { groupId: amtGroup, amt: AMT_READY, name: 'TILL-1' });
    noAmt = await enrollDevice(t, admin, { groupId: amtGroup, name: 'NO-AMT' });
    unprovisioned = await enrollDevice(t, admin, { groupId: amtGroup, amt: AMT_UNPROVISIONED, name: 'UNPROV' });
    lonely = await enrollDevice(t, admin, { groupId: amtGroup, amt: AMT_READY, name: 'LONELY' });
    flagsOff = await enrollDevice(t, admin, { groupId: plainGroup, amt: AMT_READY, name: 'FLAGS-OFF' });
    // The segment comes from `device.hello` (rule 8.2a), so each device checks in once to record it.
    for (const [d, subnetHash] of [
      [target, SUBNET],
      [noAmt, SUBNET],
      [unprovisioned, SUBNET],
      [flagsOff, SUBNET],
      [lonely, OTHER_SUBNET],
    ] as const) {
      const ws = await connectDevice(url, d, { track: sockets, subnetHash, amt: d === noAmt ? null : d === unprovisioned ? AMT_UNPROVISIONED : AMT_READY });
      await ws.next('device.hello.ok');
    }
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
    await vault.close();
  });

  it('only senior_technician and org_admin reach the console and boot redirect; wake stays with the acting roles', async () => {
    for (const acc of [tech, auditor, observer]) {
      expect((await sol(acc, target)).statusCode, `sol as ${acc.user.role}`).toBe(403);
      expect((await boot(acc, target)).statusCode, `boot as ${acc.user.role}`).toBe(403);
    }
    // Section 7.1: a technician may still wake (the "device wake / AMT power-on" row), an auditor and observer may not.
    expect((await wake(tech, target, { method: 'wol', reason: 'wol only' })).statusCode).toBe(202);
    expect((await wake(auditor, target)).statusCode).toBe(403);
    expect((await wake(observer, target)).statusCode).toBe(403);
    // No cookie at all is unauthenticated, not forbidden.
    expect((await call(t.app, `/api/v1/devices/${target.deviceId}/amt/sol`, { body: { reason: REASON } })).statusCode).toBe(401);
  });

  it('the reason is required, and the AMT policy flags default off (rule 8.4d)', async () => {
    const detail = (await call(t.app, `/api/v1/devices/${flagsOff.deviceId}`, { cookie: admin.cookie })).json();
    expect(detail).toMatchObject({ policy: { allowAmtSol: false, allowAmtBootRedirect: false } });
    // A missing, empty or whitespace-only reason never reaches the policy or the hardware.
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      expect((await sol(senior, target, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ target: 'pxe' }, { reason: REASON }, { target: 'floppy', reason: REASON }, { target: 'pxe', reason: '' }]) {
      expect((await boot(senior, target, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    // Flags off refuse before the hardware is even consulted, even though this device's AMT is ready.
    expect(codeOf(await sol(admin, flagsOff))).toBe('policy_forbidden');
    expect(codeOf(await boot(admin, flagsOff))).toBe('policy_forbidden');
    expect((await sol(admin, flagsOff)).statusCode).toBe(409);
    // The two flags are independent: with only `allowAmtSol` on, boot is still refused by policy while the console
    // gets as far as the hardware check (this device has no AMT).
    const only = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false, allowAmtSol: true });
    const solOnly = await enrollDevice(t, admin, { groupId: only, name: 'SOL-ONLY' });
    expect(codeOf(await boot(admin, solOnly))).toBe('policy_forbidden');
    expect(codeOf(await sol(admin, solOnly))).toBe('amt_unavailable');
  });

  it('hardware gating: no AMT, unprovisioned AMT, or no proxy in the segment is an honest amt_unavailable', async () => {
    for (const d of [noAmt, unprovisioned, lonely]) {
      expect(codeOf(await sol(admin, d)), `sol ${d.deviceId}`).toBe('amt_unavailable');
      expect(codeOf(await boot(admin, d)), `boot ${d.deviceId}`).toBe('amt_unavailable');
      expect(codeOf(await wake(admin, d)), `amt wake ${d.deviceId}`).toBe('amt_unavailable');
      expect((await sol(admin, d)).statusCode).toBe(409);
    }
    // Rule 8.4a: the device detail reports the inventory honestly, so the console can hide "cold power on".
    expect((await call(t.app, `/api/v1/devices/${noAmt.deviceId}`, { cookie: admin.cookie })).json()).toMatchObject({ amt: null });
    expect((await call(t.app, `/api/v1/devices/${unprovisioned.deviceId}`, { cookie: admin.cookie })).json()).toMatchObject({ amt: { present: true, provisioned: false } });
  });

  it("another org's device id is 404 on every AMT route, before any role or policy check", async () => {
    const other = await p4Admin(t);
    expect((await sol(other, target)).statusCode).toBe(404);
    expect((await boot(other, target)).statusCode).toBe(404);
    expect((await wake(other, target)).statusCode).toBe(404);
    const close = await call(t.app, `/api/v1/devices/${target.deviceId}/amt/sol/${target.deviceId}/close`, { cookie: other.cookie, body: {} });
    expect(close.statusCode).toBe(404);
  });

  it('SOL opens through the elected proxy with the vault credential sealed to it, and chains the reason', async () => {
    const before = vault.reads.length;
    const res = await sol(senior, target);
    expect(res.statusCode, res.body).toBe(201);
    const { solId, via } = res.json() as { solId: string; via: string };
    expect(via).toBe(proxyDev.deviceId);
    const cmd = await proxy.next('amt.command', (m) => m['op'] === 'sol_open');
    expect(cmd).toMatchObject({ targetDeviceId: target.deviceId, amtHost: AMT_READY.host, tls: true, op: 'sol_open' });
    // Rule 8.4c: `amt/<deviceId>` first, then the org's `amt/default`; the credential is never on a device row.
    expect(vault.reads.slice(before)).toEqual([`${admin.org.id}/amt/${target.deviceId}`, `${admin.org.id}/amt/default`]);
    const sealed = cmd['credSealed'] as Sealed;
    expect(JSON.parse(new TextDecoder().decode(openSealed(proxyDev.kexSecret, proxyDev.deviceId, 'amt-cred', sealed)))).toEqual(CRED);
    // Sealed to that one proxy for that one command: the target's own key, the wrong id and another purpose all fail.
    expect(() => openSealed(target.kexSecret, target.deviceId, 'amt-cred', sealed)).toThrow();
    expect(() => openSealed(proxyDev.kexSecret, target.deviceId, 'amt-cred', sealed)).toThrow();
    expect(() => openSealed(proxyDev.kexSecret, proxyDev.deviceId, 'vault-secret', sealed)).toThrow();
    const opened = (await auditOf('device.amt_sol_opened')).find((e) => (e.data as { solId: string }).solId === solId);
    expect(opened?.actorType).toBe('user');
    expect(opened?.actorId).toBe(senior.user.id);
    expect(opened?.reason).toBe(REASON);
    expect(opened?.data).toEqual({ deviceId: target.deviceId, solId, viaDeviceId: proxyDev.deviceId, reason: REASON });
    expect(JSON.stringify(opened)).not.toContain(CRED.pass);

    // Close: only the opener or an org_admin, once, and the transcript hash is chained (null with no bytes).
    const closePath = `/api/v1/devices/${target.deviceId}/amt/sol/${solId}/close`;
    expect((await call(t.app, closePath, { cookie: senior2.cookie, body: {} })).statusCode).toBe(403);
    const closed = await call(t.app, closePath, { cookie: senior.cookie, body: {} });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toEqual({ closed: true });
    expect((await call(t.app, closePath, { cookie: admin.cookie, body: {} })).json()).toEqual({ closed: false });
    const shut = (await auditOf('device.amt_sol_closed')).find((e) => (e.data as { solId: string }).solId === solId);
    expect(shut?.actorType).toBe('system');
    expect(shut?.data).toMatchObject({ deviceId: target.deviceId, solId, transcriptSha256: null });
    expect(typeof (shut?.data as { durationMs: unknown }).durationMs).toBe('number');
    // The proxy is told to drop the console too (rule 8.4b `sol_close`).
    expect(await proxy.next('amt.command', (m) => m['op'] === 'sol_close')).toMatchObject({ targetDeviceId: target.deviceId });
  });

  it('boot redirect answers 202 through the proxy and chains the target with the reason', async () => {
    const res = await boot(senior, target, { target: 'hdd', reason: REASON });
    expect(res.statusCode, res.body).toBe(202);
    const { cmdId, via } = res.json() as { cmdId: string; via: string };
    expect(via).toBe(proxyDev.deviceId);
    const cmd = await proxy.next('amt.command', (m) => m['cmdId'] === cmdId);
    expect(cmd).toMatchObject({ op: 'boot_redirect', targetDeviceId: target.deviceId, args: { target: 'hdd' } });
    expect(openSealed(proxyDev.kexSecret, proxyDev.deviceId, 'amt-cred', cmd['credSealed'] as Sealed).length).toBeGreaterThan(0);
    const entry = (await auditOf('device.amt_boot_redirected')).find((e) => (e.data as { cmdId: string }).cmdId === cmdId);
    expect(entry?.actorType).toBe('user');
    expect(entry?.actorId).toBe(senior.user.id);
    expect(entry?.reason).toBe(REASON);
    expect(entry?.data).toEqual({ deviceId: target.deviceId, cmdId, target: 'hdd', viaDeviceId: proxyDev.deviceId, reason: REASON });
  });

  it('power-on is a wake: 202 { method: amt } through the proxy, with device.amt_poweron chained (rule 8.4d)', async () => {
    const res = await wake(senior, target);
    expect(res.statusCode, res.body).toBe(202);
    const { wakeId, method, via } = res.json() as { wakeId: string; method: string; via: string };
    expect({ method, via }).toEqual({ method: 'amt', via: proxyDev.deviceId });
    const cmd = await proxy.next('amt.command', (m) => m['op'] === 'power_on');
    expect(cmd).toMatchObject({ targetDeviceId: target.deviceId, amtHost: AMT_READY.host, args: {} });
    const requested = (await auditOf('device.wake_requested')).find((e) => (e.data as { wakeId: string }).wakeId === wakeId);
    expect(requested?.actorType).toBe('user');
    expect(requested?.reason).toBe(REASON);
    expect(requested?.data).toMatchObject({ deviceId: target.deviceId, method: 'amt', reason: REASON });
    const poweron = (await auditOf('device.amt_poweron')).find((e) => (e.data as { wakeId: string }).wakeId === wakeId);
    expect(poweron?.actorType).toBe('system');
    expect(poweron?.data).toEqual({ deviceId: target.deviceId, wakeId, viaDeviceId: proxyDev.deviceId });
    // `auto` prefers AMT when the firmware is ready and a proxy is online (rule 8.1 W1).
    expect((await wake(senior, target, { method: 'auto', reason: REASON })).json()).toMatchObject({ method: 'amt', via: proxyDev.deviceId });
  });

  it('a vault that cannot answer refuses the console and fails the power-on honestly (rule 8.4c)', async () => {
    vault.fail = 502;
    try {
      expect((await sol(admin, target)).statusCode).toBe(503);
      expect(codeOf(await sol(admin, target))).toBe('vault_unavailable');
      expect(codeOf(await boot(admin, target))).toBe('vault_unavailable');
      const res = await wake(admin, target);
      expect(res.statusCode).toBe(202);
      const { wakeId } = res.json() as { wakeId: string };
      const failed = (await auditOf('device.wake_failed')).find((e) => (e.data as { wakeId: string }).wakeId === wakeId);
      expect(failed?.actorType).toBe('system');
      expect(failed?.data).toMatchObject({ deviceId: target.deviceId, method: 'amt', cause: 'amt_unavailable' });
    } finally {
      vault.fail = null;
    }
    // No AMT credential at all in the vault is the same refusal, not a command sent without one.
    vault.secrets.delete(`${admin.org.id}/amt/default`);
    expect(codeOf(await sol(admin, target))).toBe('vault_unavailable');
    vault.secrets.set(`${admin.org.id}/amt/default`, CRED);
  });
});
