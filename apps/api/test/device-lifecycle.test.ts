/**
 * Phase D device lifecycle over REST (docs/specs/phase-d-contracts.md rules 3.7, 3.7b, section 7.1, section 15.3
 * "disable / enable / retire / rotate-key over REST, and `device_busy`"): `POST /devices/:id/disable`, `/enable`,
 * `DELETE /devices/:id` (retire) and `POST /devices/:id/rotate-key`, each against the live socket and the live
 * session it has to take with it, their audit entries, the state machine that refuses the wrong transition, the
 * `admin` capability row (org_admin only, cross-org 404), and the one-live-session-per-device refusal
 * (`409 device_busy { sessionId }`) including the way a disable clears it.
 */
import {
  base64urlEncode,
  devicePublicKeyOf,
  deviceSigInput,
  kexPublicKeyOf,
  kidOf,
  base64urlDecode,
  signDeviceInput,
} from '@indiansassist/shared';
import { getDevice, listAuditByOrgPaginated } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, call, listen, signup, type Account, type SignalClient, type TestApp } from './helpers.js';
import { connectDevice, deviceGroup, enrollDevice, makeP4App, newDev, openDeviceSessionVia, p4Admin, type Dev } from './p4-kit.js';

describe('device lifecycle over REST (rule 3.7)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  let allowGroup: string;
  const sockets: SignalClient[] = [];

  const enroll = () => enrollDevice(t, admin, { groupId: allowGroup });
  const connect = (d: Dev, interactive = 'locked') => connectDevice(url, d, { interactive, track: sockets });
  const post = (d: Dev, path: string, acc: Account = admin) => call(t.app, `/api/v1/devices/${d.deviceId}/${path}`, { cookie: acc.cookie, body: {} });
  const detail = async (d: Dev) => (await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: admin.cookie })).json() as Record<string, unknown>;
  const retire = (d: Dev, acc: Account = admin) => call(t.app, `/api/v1/devices/${d.deviceId}`, { method: 'DELETE', cookie: acc.cookie });
  const audits = async (action: string) => (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action })).items;
  const openSession = (d: Dev, body: Record<string, unknown> = { unattended: true, reason: 'lifecycle' }) =>
    call(t.app, `/api/v1/devices/${d.deviceId}/sessions`, { cookie: admin.cookie, body });

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
    allowGroup = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('disable kicks the socket, ends the live session and refuses actions; enable brings it back', async () => {
    const d = await enroll();
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    const { sessionId } = await openDeviceSessionVia(t, admin, d, ws);

    const off = await post(d, 'disable');
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ id: d.deviceId, status: 'disabled', online: false });
    expect((await ws.next('error'))['code']).toBe('device_disabled');
    expect(await ws.closed()).toBe(4412);
    expect((await audits('device.disabled'))[0]?.data).toMatchObject({ deviceId: d.deviceId });
    expect((await audits('device.disabled'))[0]?.actorType).toBe('user');
    // Rule 3.7: the live session goes with the device, as `device_disabled`.
    expect((await call(t.app, `/api/v1/sessions/${sessionId}`, { cookie: admin.cookie })).json()).toMatchObject({
      state: 'ended',
      endReason: 'device_disabled',
    });
    // A disabled device takes no session, no action and no wake.
    expect((await openSession(d)).json()).toMatchObject({ error: { code: 'device_offline' } });
    const act = await call(t.app, `/api/v1/devices/${d.deviceId}/actions`, {
      cookie: admin.cookie,
      body: { kind: 'message', payload: { title: 'Hi', body: 'later' } },
    });
    expect(act.statusCode, act.body).toBe(409);
    expect(act.json()).toMatchObject({ error: { code: 'bad_state' } });
    // Idempotence is not silent: the transition is from `enrolled` only.
    expect((await post(d, 'disable')).statusCode).toBe(409);

    const on = await post(d, 'enable');
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ status: 'enrolled' });
    expect((await audits('device.enabled'))[0]?.data).toMatchObject({ deviceId: d.deviceId });
    expect((await post(d, 'enable')).statusCode).toBe(409);
    // It connects again with the same identity, and a session opens again.
    const again = await connect(d);
    await again.next('device.hello.ok');
    const second = await openSession(d);
    expect(second.statusCode, second.body).toBe(201);
    await again.next('device.session_open');
    await call(t.app, `/api/v1/sessions/${(second.json() as { sessionId: string }).sessionId}/end`, { cookie: admin.cookie, body: {} });
  });

  it('a device holds one live session: the second open is 409 device_busy { sessionId }', async () => {
    const d = await enroll();
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    const { sessionId } = await openDeviceSessionVia(t, admin, d, ws);
    const busy = await openSession(d, { unattended: true, reason: 'second technician' });
    expect(busy.statusCode, busy.body).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: 'device_busy', details: { sessionId } } });
    // Another user of the org is refused the same way (it is the device that is busy, not the caller).
    const senior = await addMember(t.app, admin, 'senior_technician');
    const seat = await call(t.app, `/api/v1/users/${senior.user.id}/role`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: { role: 'senior_technician', tier: 'p4_installed' },
    });
    expect(seat.statusCode, seat.body).toBe(200);
    const bySenior = await call(t.app, `/api/v1/devices/${d.deviceId}/sessions`, { cookie: senior.cookie, body: { unattended: true, reason: 'also me' } });
    expect(bySenior.json()).toMatchObject({ error: { code: 'device_busy', details: { sessionId } } });
    // An attended open is refused with the same `device_busy`, before the section 6.2 table is consulted.
    expect((await openSession(d, { unattended: false })).json()).toMatchObject({ error: { code: 'device_busy' } });
    // Ending it frees the device.
    const end = await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
    expect(end.statusCode, end.body).toBe(200);
    const third = await openSession(d);
    expect(third.statusCode, third.body).toBe(201);
    expect((third.json() as { sessionId: string }).sessionId).not.toBe(sessionId);
  });

  it('retire clears the device keys for good: no hello, no deregister, no enable', async () => {
    const d = await enroll();
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    const { sessionId } = await openDeviceSessionVia(t, admin, d, ws);
    const gone = await retire(d);
    expect(gone.statusCode, gone.body).toBe(204);
    expect((await ws.next('error'))['code']).toBe('device_disabled');
    expect(await ws.closed()).toBe(4412);
    expect((await call(t.app, `/api/v1/sessions/${sessionId}`, { cookie: admin.cookie })).json()).toMatchObject({ state: 'ended', endReason: 'device_disabled' });
    expect((await audits('device.retired'))[0]?.data).toMatchObject({ deviceId: d.deviceId });
    const row = await getDevice(t.ctx.db, d.deviceId);
    expect(row).toMatchObject({ status: 'retired', publicKey: null, keyId: null, rotationNonce: null });
    expect(await detail(d)).toMatchObject({ status: 'retired', keyId: null, online: false });
    // With no public key there is nothing left to authenticate: the hello and the signed deregister both fail.
    const rogue = await connect(d);
    expect((await rogue.next('error'))['code']).toBe('device_unauthenticated');
    const nonce = base64urlEncode(new Uint8Array(16));
    const ts = Date.now();
    const dereg = await call(t.app, `/api/v1/devices/${d.deviceId}/deregister`, {
      body: { ts, nonce, sig: signDeviceInput(deviceSigInput.deregister({ deviceId: d.deviceId, ts, nonce }), d.seed) },
    });
    expect(dereg.statusCode, dereg.body).toBe(401);
    expect((await post(d, 'enable')).statusCode).toBe(409);
    expect((await post(d, 'rotate-key')).statusCode).toBe(409);
    expect((await retire(d)).statusCode).toBe(409);
  });

  it('rotate-key arms a nonce the device spends once over its socket (rule 3.7b)', async () => {
    const d = await enroll();
    const first = await connect(d);
    expect((await first.next('device.hello.ok'))['rotationNonce']).toBeNull();
    const armed = await post(d, 'rotate-key');
    expect(armed.statusCode, armed.body).toBe(200);
    expect(armed.json()).toEqual({ rotationArmed: true });
    expect((await audits('device.key_rotation_armed'))[0]?.data).toMatchObject({ deviceId: d.deviceId });
    const row = await getDevice(t.ctx.db, d.deviceId);
    expect(typeof row?.rotationNonce).toBe('string');

    // The nonce reaches the device on its next check-in, and only there.
    const ws = await connect(d);
    const hello = await ws.next('device.hello.ok');
    const rotationNonce = String(hello['rotationNonce']);
    expect(rotationNonce).toBe(row!.rotationNonce);

    const next = newDev();
    const newPublicKey = devicePublicKeyOf(next.seed);
    const newKexPublicKey = kexPublicKeyOf(next.kexSecret);
    const oldKeyId = d.keyId;
    ws.send({
      t: 'device.rotate',
      newPublicKey,
      newKexPublicKey,
      oldKeySig: signDeviceInput(deviceSigInput.rotate({ deviceId: d.deviceId, rotationNonce, newPublicKey, newKexPublicKey }), d.seed),
      newKeyProof: signDeviceInput(deviceSigInput.rotateNew({ deviceId: d.deviceId, rotationNonce, oldKeyId }), next.seed),
    });
    const ok = await ws.next('device.rotate.ok');
    const newKeyId = kidOf(base64urlDecode(newPublicKey));
    expect(ok['keyId']).toBe(newKeyId);
    expect((await audits('device.key_rotated'))[0]?.data).toMatchObject({ deviceId: d.deviceId, fromKeyId: oldKeyId, toKeyId: newKeyId });
    expect((await audits('device.key_rotated'))[0]?.actorType).toBe('device');
    const after = await getDevice(t.ctx.db, d.deviceId);
    expect(after).toMatchObject({ publicKey: newPublicKey, keyId: newKeyId, kexPublicKey: newKexPublicKey, rotationNonce: null });
    // A second rotation on the spent nonce is refused, and the old key no longer authenticates.
    ws.send({
      t: 'device.rotate',
      newPublicKey,
      newKexPublicKey,
      oldKeySig: signDeviceInput(deviceSigInput.rotate({ deviceId: d.deviceId, rotationNonce, newPublicKey, newKexPublicKey }), d.seed),
      newKeyProof: signDeviceInput(deviceSigInput.rotateNew({ deviceId: d.deviceId, rotationNonce, oldKeyId }), next.seed),
    });
    expect((await ws.next('error'))['code']).toBe('bad_state');
    const old = await connect(d);
    expect((await old.next('error'))['code']).toBe('device_unauthenticated');
    next.deviceId = d.deviceId;
    const rotated = await connect(next);
    expect((await rotated.next('device.hello.ok'))['deviceId']).toBe(d.deviceId);
    expect((await detail(d))['keyId']).toBe(newKeyId);
  });

  it('every lifecycle route is org_admin only, and a device of another org is a 404', async () => {
    const d = await enroll();
    const other = await signup(t.app);
    for (const call_ of [
      () => post(d, 'disable', other),
      () => post(d, 'enable', other),
      () => post(d, 'rotate-key', other),
      () => retire(d, other),
    ]) {
      expect((await call_()).statusCode).toBe(404);
    }
    for (const role of ['senior_technician', 'technician', 'auditor', 'observer']) {
      const member = await addMember(t.app, admin, role);
      expect((await post(d, 'disable', member)).statusCode, `disable as ${role}`).toBe(403);
      expect((await post(d, 'enable', member)).statusCode, `enable as ${role}`).toBe(403);
      expect((await post(d, 'rotate-key', member)).statusCode, `rotate-key as ${role}`).toBe(403);
      expect((await retire(d, member)).statusCode, `retire as ${role}`).toBe(403);
    }
    // Nothing happened to the device while they tried.
    expect(await detail(d)).toMatchObject({ status: 'enrolled' });
    expect((await getDevice(t.ctx.db, d.deviceId))?.rotationNonce).toBeNull();
  });
});
