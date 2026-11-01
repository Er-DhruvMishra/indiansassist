/**
 * Phase D self-healing and tamper alerts (docs/specs/phase-d-contracts.md section 10, rule 10.2, section 15.3 "the
 * silent-past-grace sweep to `tamper.suspected`"): the sweeper pass that marks an enrolled device `suspected` once it
 * has been silent past `tamperSilentGraceSec` -- with the cases it must leave alone (a device that is online, one
 * that has never checked in, one that is disabled or retired, and one that is already `alerted` from a signed
 * event) -- its `tamper.suspected` chain entry, the acknowledgement that clears it, and the fact that an
 * acknowledged device that stays silent is suspected again on the next pass.
 */
import { LIMITS } from '@indiansassist/shared';
import { getDevice, listAuditByOrgPaginated, updateDevice } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, type Account, type SignalClient, type TestApp } from './helpers.js';
import { connectDevice, deviceGroup, enrollDevice, makeP4App, p4Admin, tamperEvent, type Dev } from './p4-kit.js';
import { sweepSilentDevices } from '../src/fleet/tamper.js';
import { Sweeper } from '../src/sweeper.js';

describe('the silent-past-grace sweep (rule 10.2)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  let group: string;
  const sockets: SignalClient[] = [];

  const stateOf = async (d: Dev) => (await getDevice(t.ctx.db, d.deviceId))?.tamperState;
  const suspicions = async () => (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'tamper.suspected', limit: 200 })).items;
  /** Backdates the last check-in so the device looks silent for `sec` seconds. */
  const silence = (d: Dev, sec: number) => updateDevice(t.ctx.db, d.deviceId, { lastSeenAt: new Date(Date.now() - sec * 1000) });
  /** A device that has checked in once and is now off the air (its presence entry gone with its socket). */
  const parked = async (opts: { interactive?: string } = {}) => {
    const d = await enrollDevice(t, admin, { groupId: group, ...opts });
    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    ws.close();
    await expect.poll(async () => (await t.ctx.presence.getKey(`ia:dev:${d.deviceId}`)) === null).toBe(true);
    return d;
  };

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
    group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('marks a device silent past the grace as suspected, once, and chains how long it was silent', async () => {
    const d = await parked();
    expect(await stateOf(d)).toBe('ok');
    // Inside the grace it is just a device that has not reported yet.
    await silence(d, LIMITS.tamperSilentGraceSec - 60);
    await sweepSilentDevices(t.ctx);
    expect(await stateOf(d)).toBe('ok');
    expect(await suspicions()).toHaveLength(0);

    // Past it, the service is presumed stopped: the fleet view must say so without the device's help (section 10).
    await silence(d, LIMITS.tamperSilentGraceSec + 120);
    await new Sweeper(t.ctx).runOnce();
    expect(await stateOf(d)).toBe('suspected');
    const entry = (await suspicions())[0];
    expect(entry?.data).toMatchObject({ deviceId: d.deviceId });
    expect(entry?.actorType).toBe('system');
    expect((entry?.data as { silentSec: number }).silentSec).toBeGreaterThanOrEqual(LIMITS.tamperSilentGraceSec);
    expect(typeof (entry?.data as { lastSeenAt: string }).lastSeenAt).toBe('string');
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: admin.cookie })).json()).toMatchObject({ tamperState: 'suspected' });
    // Not again on the next pass: `suspected` is reached from `ok` only.
    await sweepSilentDevices(t.ctx);
    expect(await suspicions()).toHaveLength(1);

    // The admin acknowledges it, which records the cause it had and clears the flag.
    const ack = await call(t.app, `/api/v1/devices/${d.deviceId}/tamper/acknowledge`, { cookie: admin.cookie, body: { note: 'machine is in storage' } });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json()).toMatchObject({ tamperState: 'ok' });
    const acked = (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'tamper.acknowledged' })).items[0];
    expect(acked?.data).toMatchObject({ deviceId: d.deviceId, cause: 'suspected', note: 'machine is in storage' });
    // Still silent, so the next pass suspects it again: acknowledging is not silencing.
    await sweepSilentDevices(t.ctx);
    expect(await stateOf(d)).toBe('suspected');
    expect(await suspicions()).toHaveLength(2);
  });

  it('leaves alone a device that is online, one that has never checked in, and one that is not enrolled', async () => {
    // Online: the row's `last_seen_at` can lag (it is written on check-ins), the presence entry is the truth.
    const live = await enrollDevice(t, admin, { groupId: group });
    const ws = await connectDevice(url, live, { track: sockets });
    await ws.next('device.hello.ok');
    await silence(live, LIMITS.tamperSilentGraceSec + 600);
    await sweepSilentDevices(t.ctx);
    expect(await stateOf(live)).toBe('ok');

    // Never seen: an enrolled device that has not connected yet is not a tamper, it is an installation in progress.
    const never = await enrollDevice(t, admin, { groupId: group });
    expect((await getDevice(t.ctx.db, never.deviceId))?.lastSeenAt).toBeNull();
    await sweepSilentDevices(t.ctx);
    expect(await stateOf(never)).toBe('ok');

    // Disabled or retired: silence is what an administrator asked for (rule 10.2 "with no disable / retire on record").
    const disabled = await parked();
    await silence(disabled, LIMITS.tamperSilentGraceSec + 600);
    expect((await call(t.app, `/api/v1/devices/${disabled.deviceId}/disable`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
    const retired = await parked();
    await silence(retired, LIMITS.tamperSilentGraceSec + 600);
    expect((await call(t.app, `/api/v1/devices/${retired.deviceId}`, { method: 'DELETE', cookie: admin.cookie })).statusCode).toBe(204);
    await sweepSilentDevices(t.ctx);
    expect(await stateOf(disabled)).toBe('ok');
    expect(await stateOf(retired)).toBe('ok');
    expect((await suspicions()).map((e) => (e.data as { deviceId: string }).deviceId)).not.toContain(disabled.deviceId);

    ws.close();
  });

  it('does not overwrite an alerted device: a signed event outranks a guess', async () => {
    const d = await enrollDevice(t, admin, { groupId: group });
    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    // Section 10: the service came back and reported, signed, that it had been stopped.
    const ev = tamperEvent(d, 'stopped', 'the service was stopped from services.msc');
    ws.send({ t: 'device.tamper', events: [ev] });
    expect((await ws.next('device.tamper.ok'))['ids']).toEqual([ev.id]);
    expect(await stateOf(d)).toBe('alerted');
    const alert = (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'tamper.alert' })).items[0];
    expect(alert?.data).toMatchObject({ deviceId: d.deviceId, eventId: ev.id, cause: 'stopped' });
    expect(alert?.actorType).toBe('device');

    ws.close();
    await expect.poll(async () => (await t.ctx.presence.getKey(`ia:dev:${d.deviceId}`)) === null).toBe(true);
    await silence(d, LIMITS.tamperSilentGraceSec + 600);
    await sweepSilentDevices(t.ctx);
    // The honest cause survives the sweep.
    expect(await stateOf(d)).toBe('alerted');
    expect((await suspicions()).map((e) => (e.data as { deviceId: string }).deviceId)).not.toContain(d.deviceId);
  });
});
