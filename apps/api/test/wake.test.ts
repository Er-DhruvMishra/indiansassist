/**
 * Phase D wake on LAN and the waker mesh (docs/specs/phase-d-contracts.md section 8, section 15.3 "the four failure
 * causes server-side, and the MAC-at-rest and log-redaction assertions"): every `WakeFailCause` raised by the server
 * itself -- `no_waker` (no MAC, no waker in the segment, mesh off), `waker_error` (the waker says it could not send),
 * `no_confirm` (the sweep and the too-late check-in), `amt_unavailable` (no AMT credential to seal) and
 * `amt_unreachable` (the proxy could not reach the firmware) -- each with its `device.wake_failed` chain entry and
 * its S->A push, against the confirmed wake so none of it is vacuous; and rule 8.2c: the wake MAC is readable
 * nowhere -- not in the row, not on REST, not in the chain, not in a log line -- except inside the blob sealed to
 * the one elected waker.
 */
import {
  LIMITS,
  openSealed,
  type AmtInventory,
  type Sealed,
} from '@indiansassist/shared';
import { getDevice, getWakeAttempt, listAuditByOrgPaginated, wakeAttempt } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, captureLogLines, listen, SignalClient, type Account, type Msg, type TestApp } from './helpers.js';
import { startFakeVault, vaultEnv, type FakeVault } from './fake-vault.js';
import {
  connectDevice,
  deviceGroup,
  enrollDevice,
  makeP4App,
  newDev,
  p4Admin,
  SERVICE_FEATURES_BASE,
  type Dev,
} from './p4-kit.js';
import { decryptMac } from '../src/fleet/common.js';
import { sweepWakes } from '../src/fleet/wake.js';

const MAC = 'aabbccddeeff';
const AMT: AmtInventory = { present: true, provisioned: true, version: '12.0', host: '10.1.2.3', tls: true, powerState: 5 };

/** An Assist socket of `acc` on `/signal`, where the S->A wake pushes arrive. */
async function assistSocket(url: string, acc: Account, track: SignalClient[]): Promise<SignalClient> {
  const ws = await SignalClient.open(url, { cookie: acc.cookie });
  track.push(ws);
  await ws.request({ t: 'assist.hello' }, 'assist.hello.ok');
  return ws;
}

describe('wake failure causes (section 8.2, 8.3)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  let assist: SignalClient;
  let group: string;
  const sockets: SignalClient[] = [];

  const wake = (d: Dev, method: 'auto' | 'wol' | 'amt', reason = 'the user is away') =>
    call(t.app, `/api/v1/devices/${d.deviceId}/wake`, { cookie: admin.cookie, body: { method, reason } });
  const attempt = (id: string) => getWakeAttempt(t.ctx.db, id);
  const failures = async () => (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'device.wake_failed' })).items;
  const peer = async (feature: 'waker' | 'amt_proxy') => {
    const p = await enrollDevice(t, admin, { groupId: group, dev: newDev([...SERVICE_FEATURES_BASE, feature]) });
    const ws = await connectDevice(url, p, { track: sockets });
    await ws.next('device.hello.ok');
    return { dev: p, ws };
  };
  /** A target that has checked in once (so the server knows its segment and its MAC) and is now asleep. */
  const target = async (opts: { mac?: string | null; amt?: AmtInventory | null } = {}) => {
    const d = await enrollDevice(t, admin, { groupId: group, wakeMac: opts.mac ?? null, amt: opts.amt ?? null });
    const ws = await connectDevice(url, d, { wakeMac: opts.mac ?? null, amt: opts.amt ?? null, track: sockets });
    await ws.next('device.hello.ok');
    ws.close();
    return d;
  };

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
    group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
    assist = await assistSocket(url, admin, sockets);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('no_waker: no MAC on record, nobody to send it, or the mesh switched off', async () => {
    // (1) The device never reported a wake NIC, so there is nothing to put in a magic packet.
    const noMac = await target();
    const w1 = await wake(noMac, 'wol');
    expect(w1.statusCode, w1.body).toBe(202);
    expect(w1.json()).toMatchObject({ method: 'wol', via: null });
    const id1 = (w1.json() as { wakeId: string }).wakeId;
    expect(await attempt(id1)).toMatchObject({ state: 'failed', cause: 'no_waker', via: null });
    const push1 = await assist.next('device.wake_failed', (m) => m['wakeId'] === id1);
    expect(push1).toMatchObject({ deviceId: noMac.deviceId, cause: 'no_waker' });
    expect((await failures()).some((e) => (e.data as { wakeId: string }).wakeId === id1)).toBe(true);
    expect((await failures())[0]?.actorType).toBe('system');

    // (2) A MAC on record but no peer in the segment that advertises `waker` and is online.
    const alone = await target({ mac: MAC });
    const w2 = await wake(alone, 'wol');
    const id2 = (w2.json() as { wakeId: string }).wakeId;
    expect(await attempt(id2)).toMatchObject({ state: 'failed', cause: 'no_waker' });
    expect((await assist.next('device.wake_failed', (m) => m['wakeId'] === id2))['cause']).toBe('no_waker');
    // An enrolled waker that is not connected is not a waker: election is over online peers only.
    const offline = await enrollDevice(t, admin, { groupId: group, dev: newDev([...SERVICE_FEATURES_BASE, 'waker']) });
    await connectDevice(url, offline, { track: sockets }).then(async (ws) => {
      await ws.next('device.hello.ok');
      ws.close();
    });
    await new Promise((r) => setTimeout(r, 50));
    await t.ctx.presence.delKey(`ia:dev:${offline.deviceId}`);
    const w3 = await wake(alone, 'wol');
    expect(await attempt((w3.json() as { wakeId: string }).wakeId)).toMatchObject({ state: 'failed', cause: 'no_waker' });

    // (3) The org turned the mesh off: an online waker is not used (section 8.2 is opt-out per org).
    const waker = await peer('waker');
    const off = await call(t.app, '/api/v1/orgs/current/policy/fleet', { method: 'PATCH', cookie: admin.cookie, body: { wakerMeshEnabled: false } });
    expect(off.json()).toMatchObject({ wakerMeshEnabled: false });
    const w4 = await wake(alone, 'wol');
    expect(await attempt((w4.json() as { wakeId: string }).wakeId)).toMatchObject({ state: 'failed', cause: 'no_waker', via: null });
    expect(await waker.ws.quiet('wake.send')).toBe(true);
    await call(t.app, '/api/v1/orgs/current/policy/fleet', { method: 'PATCH', cookie: admin.cookie, body: { wakerMeshEnabled: true } });
  });

  it('waker_error: the elected waker reports it could not put the packet on the wire', async () => {
    const waker = await peer('waker');
    const d = await target({ mac: MAC });
    const r = await wake(d, 'wol');
    const wakeId = (r.json() as { wakeId: string }).wakeId;
    expect(r.json()).toMatchObject({ method: 'wol', via: waker.dev.deviceId });
    const sent = await waker.ws.next('wake.send');
    expect(sent['wakeId']).toBe(wakeId);
    expect(await attempt(wakeId)).toMatchObject({ state: 'dispatched', via: waker.dev.deviceId });
    waker.ws.send({ t: 'wake.sent', wakeId, ok: false, error: 'no route to the broadcast address' });
    const push = await assist.next('device.wake_failed', (m) => m['wakeId'] === wakeId);
    expect(push).toMatchObject({ deviceId: d.deviceId, cause: 'waker_error' });
    expect(await attempt(wakeId)).toMatchObject({ state: 'failed', cause: 'waker_error' });
    // Rule 8.2c: the MAC travelled only inside a blob sealed to this one waker, and it is the right MAC.
    const sealed = sent['targetMacSealed'] as Sealed;
    expect(new TextDecoder().decode(openSealed(waker.dev.kexSecret, waker.dev.deviceId, 'wake-mac', sealed))).toBe(MAC);
    expect(() => openSealed(d.kexSecret, d.deviceId, 'wake-mac', sealed)).toThrow();
    expect(() => openSealed(waker.dev.kexSecret, waker.dev.deviceId, 'amt-cred', sealed)).toThrow();
    expect(JSON.stringify(sent)).not.toContain(MAC);
    // A `wake.sent` from a device that is not the elected waker is not accepted as this attempt's outcome.
    const other = await peer('waker');
    const second = await wake(d, 'wol');
    const secondId = (second.json() as { wakeId: string }).wakeId;
    const elected = second.json() as { via: string };
    const bystander = elected.via === waker.dev.deviceId ? other : waker;
    bystander.ws.send({ t: 'wake.sent', wakeId: secondId, ok: false });
    expect((await bystander.ws.next('error'))['code']).toBe('bad_state');
    expect(await attempt(secondId)).toMatchObject({ state: 'dispatched' });
  });

  it('no_confirm: the sweep fails an unconfirmed wake, and a check-in after the window does not count as woke', async () => {
    const waker = await peer('waker');
    const d = await target({ mac: MAC });

    // (1) The target never comes back: the sweeper fails the attempt once the window has passed.
    const first = await wake(d, 'wol');
    const id1 = (first.json() as { wakeId: string }).wakeId;
    await waker.ws.next('wake.send');
    await sweepWakes(t.ctx, new Date(Date.now() + (t.ctx.config.fleet.wakeConfirmSec + 60) * 1000));
    expect(await attempt(id1)).toMatchObject({ state: 'failed', cause: 'no_confirm' });
    expect((await assist.next('device.wake_failed', (m) => m['wakeId'] === id1))['cause']).toBe('no_confirm');
    // The sweep is idempotent: a failed attempt is not failed again.
    const before = (await failures()).length;
    await sweepWakes(t.ctx, new Date(Date.now() + (t.ctx.config.fleet.wakeConfirmSec + 60) * 1000));
    expect((await failures()).length).toBe(before);

    // (2) The target does come back, but too late: W3 counts the elapsed time, not the mere arrival.
    const late = await wake(d, 'wol');
    const id2 = (late.json() as { wakeId: string }).wakeId;
    await waker.ws.next('wake.send');
    await t.ctx.db
      .update(wakeAttempt)
      .set({ createdAt: new Date(Date.now() - (t.ctx.config.fleet.wakeConfirmSec + 30) * 1000) })
      .where(eq(wakeAttempt.id, id2));
    const back = await connectDevice(url, d, { wakeMac: MAC, track: sockets });
    await back.next('device.hello.ok');
    expect(await attempt(id2)).toMatchObject({ state: 'failed', cause: 'no_confirm' });
    expect((await assist.next('device.wake_failed', (m) => m['wakeId'] === id2))['cause']).toBe('no_confirm');
    back.close();
    await t.ctx.presence.delKey(`ia:dev:${d.deviceId}`);

    // (3) In the window it is a wake, pushed as `device.woke` -- so (1) and (2) are about the window, not the plumbing.
    const good = await wake(d, 'wol');
    const id3 = (good.json() as { wakeId: string }).wakeId;
    await waker.ws.next('wake.send');
    const woken = await connectDevice(url, d, { wakeMac: MAC, track: sockets });
    await woken.next('device.hello.ok');
    const woke = await assist.next('device.woke', (m) => m['wakeId'] === id3);
    expect(woke).toMatchObject({ deviceId: d.deviceId, method: 'wol', via: waker.dev.deviceId });
    expect(typeof woke['elapsedMs']).toBe('number');
    expect(await attempt(id3)).toMatchObject({ state: 'woke', cause: null });
    expect((await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'device.woke' })).items[0]?.data).toMatchObject({
      deviceId: d.deviceId,
      wakeId: id3,
    });
  });

  it('amt_unavailable: an AMT power-on with no credential to seal fails honestly and sends no command', async () => {
    const proxy = await peer('amt_proxy');
    const d = await target({ amt: AMT });
    expect((await getDevice(t.ctx.db, d.deviceId))?.amt).toMatchObject({ present: true, provisioned: true });
    const r = await wake(d, 'amt');
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ method: 'amt', via: proxy.dev.deviceId });
    const wakeId = (r.json() as { wakeId: string }).wakeId;
    // No vault is configured on this app, so there is no AMT credential: nothing is sent to the proxy.
    expect(await proxy.ws.quiet('amt.command')).toBe(true);
    expect(await attempt(wakeId)).toMatchObject({ state: 'failed', cause: 'amt_unavailable' });
    expect((await assist.next('device.wake_failed', (m) => m['wakeId'] === wakeId))['cause']).toBe('amt_unavailable');
    expect((await failures()).find((e) => (e.data as { wakeId: string }).wakeId === wakeId)?.data).toMatchObject({ method: 'amt', cause: 'amt_unavailable' });
    // Rule 8.4a: without the hardware, or with nobody to proxy for it, the route itself refuses.
    const plain = await target({ mac: MAC });
    expect((await wake(plain, 'amt')).json()).toMatchObject({ error: { code: 'amt_unavailable' } });
    proxy.ws.close();
    await t.ctx.presence.delKey(`ia:dev:${proxy.dev.deviceId}`);
    expect((await wake(d, 'amt')).json()).toMatchObject({ error: { code: 'amt_unavailable' } });
  });
});

describe('amt_unreachable: the proxy reaches us but not the firmware (rule 8.4b)', () => {
  let t: TestApp;
  let url: string;
  let vault: FakeVault;
  let admin: Account;
  let assist: SignalClient;
  const sockets: SignalClient[] = [];

  beforeAll(async () => {
    vault = await startFakeVault();
    t = await makeP4App(vaultEnv(vault));
    url = await listen(t.app);
    admin = await p4Admin(t);
    vault.secrets.set(`${admin.org.id}/amt/default`, { user: 'amt-admin', pass: 'n0t-l0gged' });
    assist = await assistSocket(url, admin, sockets);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
    await vault.close();
  });

  it('dispatches the power-on, then fails the attempt on the proxy result', async () => {
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
    const proxyDev = await enrollDevice(t, admin, { groupId: group, dev: newDev([...SERVICE_FEATURES_BASE, 'amt_proxy']) });
    const proxy = await connectDevice(url, proxyDev, { track: sockets });
    await proxy.next('device.hello.ok');
    const d = await enrollDevice(t, admin, { groupId: group, amt: AMT });
    const first = await connectDevice(url, d, { amt: AMT, track: sockets });
    await first.next('device.hello.ok');
    first.close();

    const r = await call(t.app, `/api/v1/devices/${d.deviceId}/wake`, { cookie: admin.cookie, body: { method: 'amt', reason: 'cold start for patching' } });
    expect(r.statusCode, r.body).toBe(202);
    const wakeId = (r.json() as { wakeId: string }).wakeId;
    const cmd: Msg = await proxy.next('amt.command');
    expect(cmd).toMatchObject({ op: 'power_on', targetDeviceId: d.deviceId, amtHost: AMT.host, tls: true });
    expect(await getWakeAttempt(t.ctx.db, wakeId)).toMatchObject({ state: 'dispatched', via: proxyDev.deviceId, method: 'amt' });
    expect((await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'device.amt_poweron' })).items[0]?.data).toMatchObject({
      deviceId: d.deviceId,
      wakeId,
      viaDeviceId: proxyDev.deviceId,
    });
    proxy.send({ t: 'amt.result', cmdId: cmd['cmdId'], ok: false, error: 'amt_unreachable' });
    const push = await assist.next('device.wake_failed', (m) => m['wakeId'] === wakeId);
    expect(push).toMatchObject({ cause: 'amt_unreachable', deviceId: d.deviceId });
    expect(await getWakeAttempt(t.ctx.db, wakeId)).toMatchObject({ state: 'failed', cause: 'amt_unreachable' });
    const entry = (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'device.wake_failed' })).items[0];
    expect(entry?.data).toMatchObject({ wakeId, cause: 'amt_unreachable', method: 'amt' });
    expect(entry?.actorType).toBe('system');
  });
});

describe('the wake MAC is readable nowhere but inside the waker blob (rule 8.2c, section 14)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  let lines: string[];
  const sockets: SignalClient[] = [];

  beforeAll(async () => {
    // A real log level, with the app's own pino stream captured: these are the lines a self-host would keep.
    t = await makeP4App({}, { logLevel: 'debug' });
    lines = captureLogLines(t.app);
    url = await listen(t.app);
    admin = await p4Admin(t);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('is sealed at rest under the device id, and never in a row, a response, the chain or a log line', async () => {
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
    const wakerDev = await enrollDevice(t, admin, { groupId: group, dev: newDev([...SERVICE_FEATURES_BASE, 'waker']) });
    const waker = await connectDevice(url, wakerDev, { track: sockets });
    await waker.next('device.hello.ok');
    // The MAC arrives at enrollment, is cleared by a check-in that reports none, and comes back on a heartbeat.
    const d = await enrollDevice(t, admin, { groupId: group, wakeMac: MAC });
    const row0 = await getDevice(t.ctx.db, d.deviceId);
    expect(row0?.macEnc).toBeTruthy();
    expect(decryptMac(t.ctx, d.deviceId, row0!.macEnc!)).toBe(MAC);
    // Rule 8.2c: the ciphertext is bound to the device id, so a row moved to another device opens into nothing.
    expect(decryptMac(t.ctx, wakerDev.deviceId, row0!.macEnc!)).toBeNull();
    // At rest it is a sealed blob and an HMAC, not the address: neither column contains it in any readable form.
    expect(JSON.stringify(row0)).not.toContain(MAC);
    expect(row0?.macHash).not.toContain(MAC);
    expect(row0?.macHash).toMatch(/^[0-9a-f]{64}$/);

    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    expect((await getDevice(t.ctx.db, d.deviceId))?.macEnc).toBeNull();
    ws.send({ t: 'device.heartbeat', wakeMac: MAC, interactive: { state: 'locked', idleSec: 1, at: Date.now() } });
    await new Promise((r) => setTimeout(r, 200));
    const row = await getDevice(t.ctx.db, d.deviceId);
    expect(decryptMac(t.ctx, d.deviceId, row!.macEnc!)).toBe(MAC);
    ws.close();
    await t.ctx.presence.delKey(`ia:dev:${d.deviceId}`);

    // Nothing the console can read carries it: the fleet list, the detail and the chain are all clean.
    const list = await call(t.app, '/api/v1/devices', { cookie: admin.cookie });
    const detail = await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: admin.cookie });
    expect(detail.statusCode, detail.body).toBe(200);
    for (const body of [list.body, detail.body]) {
      expect(body).not.toContain(MAC);
      expect(body).not.toContain('macEnc');
      expect(body).not.toContain('macHash');
      expect(body).not.toContain('wakeMac');
    }
    const r = await call(t.app, `/api/v1/devices/${d.deviceId}/wake`, { cookie: admin.cookie, body: { method: 'wol', reason: 'nightly patching' } });
    expect(r.statusCode, r.body).toBe(202);
    const sent = await waker.next('wake.send');
    expect(new TextDecoder().decode(openSealed(wakerDev.kexSecret, wakerDev.deviceId, 'wake-mac', sent['targetMacSealed'] as Sealed))).toBe(MAC);
    const chain = await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { limit: 200 });
    expect(chain.items.length).toBeGreaterThan(5);
    expect(JSON.stringify(chain.items)).not.toContain(MAC);

    // The log: the capture has to be working (we are reading real lines), and not one of them holds the address.
    expect(lines.length).toBeGreaterThan(0);
    const log = lines.join('\n');
    expect(log).toContain('"level"');
    expect(log).not.toContain(MAC);
    expect(log).not.toContain(row!.macEnc!);
    // Belt and braces: the formats a sloppy serialiser might produce are absent too.
    expect(log).not.toContain('aa:bb:cc:dd:ee:ff');
    expect(log).not.toContain('AABBCCDDEEFF');
    expect(log).not.toContain((sent['targetMacSealed'] as Sealed).ct);
    expect(LIMITS.wakeConfirmSec).toBeGreaterThan(0);
  });
});
