/**
 * Phase D api (docs/specs/phase-d-contracts.md sections 3, 6.2, 7.1, 9): enrollment (signed config, possession proof,
 * the maxDevices race), `/signal/device` auth (Origin, forbidden hellos, bad signature / disabled -> 4412), the
 * section 6.2 refusals at `POST /devices/:id/sessions`, fleet RBAC with scoping on and off, cross-org 404, the worker
 * credential's capability subset, and the action `deny` gate.
 */
import { randomBytes } from 'node:crypto';
import {
  base64urlDecode,
  base64urlEncode,
  devicePublicKeyOf,
  deviceSigInput,
  kexPublicKeyOf,
  kidOf,
  signDeviceInput,
} from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, call, createToken, listen, makeApp, signup, SignalClient, type Account, type TestApp } from './helpers.js';

const CAPS = {
  monitors: 1,
  elevation: 'admin',
  features: ['screen', 'input', 'chat', 'service_input'],
  encoders: ['vp8'],
  hwEncoder: false,
  interpreters: ['powershell'],
  serviceVersion: '0.4.0',
};

type Dev = { seed: Uint8Array; publicKey: string; kex: string; keyId: string; deviceId?: string };

function newDev(): Dev {
  const seed = new Uint8Array(randomBytes(32));
  const publicKey = devicePublicKeyOf(seed);
  return { seed, publicKey, kex: kexPublicKeyOf(new Uint8Array(randomBytes(32))), keyId: kidOf(base64urlDecode(publicKey)) };
}

function enrollBody(d: Dev, enrollConfig: string, tokenId: string, interactive = 'locked') {
  return {
    enrollConfig,
    devicePublicKey: d.publicKey,
    deviceKexPublicKey: d.kex,
    deviceKeyProof: signDeviceInput(deviceSigInput.enroll({ tokenId, devicePublicKey: d.publicKey, deviceKexPublicKey: d.kex }), d.seed),
    machine: {
      name: 'PC',
      platform: 'windows',
      osVersion: '10.0',
      arch: 'x64',
      serviceVersion: '0.4.0',
      hwFingerprint: randomBytes(32).toString('hex'),
      wakeMac: null,
      amt: null,
      capabilities: CAPS,
      interactive: { state: interactive, idleSec: null, at: 1 },
    },
  };
}

describe('phase D api', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  const sockets: SignalClient[] = [];

  async function enrollConfig(acc: Account, maxDevices: number, groupId?: string): Promise<{ cfg: string; tokenId: string }> {
    const tok = await createToken(t.app, acc, { tier: 'p4_installed', typ: 'enrollment', maxDevices });
    const res = await call(t.app, `/api/v1/devices/enroll-config?tokenId=${tok.token.id}${groupId ? `&groupId=${groupId}` : ''}`, { cookie: acc.cookie });
    expect(res.statusCode).toBe(200);
    return { cfg: (res.json() as { iaconfig: string }).iaconfig, tokenId: tok.token.id };
  }

  async function enroll(acc: Account, opts: { groupId?: string; interactive?: string } = {}): Promise<Dev> {
    const d = newDev();
    const { cfg, tokenId } = await enrollConfig(acc, 1, opts.groupId);
    const res = await call(t.app, '/api/v1/devices/enroll', { body: enrollBody(d, cfg, tokenId, opts.interactive) });
    expect(res.statusCode, res.body).toBe(201);
    d.deviceId = (res.json() as { deviceId: string }).deviceId;
    return d;
  }

  async function connect(d: Dev, interactive = 'locked', badSig = false): Promise<SignalClient> {
    const ws = await SignalClient.open(url.replace(/\/signal$/, '/signal/device'), { origin: null });
    sockets.push(ws);
    const ch = await ws.next('device.challenge');
    const nonce = base64urlEncode(new Uint8Array(randomBytes(16)));
    const sig = badSig
      ? base64urlEncode(new Uint8Array(64))
      : signDeviceInput(deviceSigInput.hello({ deviceId: d.deviceId!, serverChallenge: String(ch['serverChallenge']), nonce }), d.seed);
    ws.send({
      t: 'device.hello',
      deviceId: d.deviceId,
      keyId: d.keyId,
      nonce,
      sig,
      client: {
        serviceVersion: '0.4.0',
        agentVersion: '0.4.0',
        osVersion: '10.0',
        arch: 'x64',
        capabilities: CAPS,
        lanSegment: { subnetHash: 'a'.repeat(64), gatewayMacHash: 'b'.repeat(64) },
        wakeMac: null,
        amt: null,
        interactive: { state: interactive, idleSec: null, at: Date.now() },
      },
    });
    return ws;
  }

  async function group(acc: Account, defaultPolicy: Record<string, unknown>): Promise<string> {
    const res = await call(t.app, '/api/v1/orgs/current/device-groups', { cookie: acc.cookie, body: { name: `g-${randomBytes(3).toString('hex')}`, defaultPolicy } });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  const openSession = (acc: Account, d: Dev, body: Record<string, unknown>) => call(t.app, `/api/v1/devices/${d.deviceId}/sessions`, { cookie: acc.cookie, body });

  beforeAll(async () => {
    t = await makeApp({ SIGNUP_PLAN_TIER: 'p4_installed' });
    url = await listen(t.app);
    admin = await signup(t.app);
    const r = await call(t.app, `/api/v1/users/${admin.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'org_admin', tier: 'p4_installed' } });
    expect(r.statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('enrollment: N racing calls on a token with K places yield exactly K devices, then 410', async () => {
    const { cfg, tokenId } = await enrollConfig(admin, 3);
    const results = await Promise.all(Array.from({ length: 6 }, () => call(t.app, '/api/v1/devices/enroll', { body: enrollBody(newDev(), cfg, tokenId) })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 410)).toHaveLength(3);
  });

  it('enrollment refuses a non-enrollment token config and a bad proof', async () => {
    const tok = await createToken(t.app, admin, { tier: 'p4_installed', typ: 'enrollment' });
    expect((await call(t.app, `/api/v1/devices/enroll-config?tokenId=${tok.token.id}&groupId=00000000-0000-4000-8000-000000000000`, { cookie: admin.cookie })).json()).toMatchObject({ error: { code: 'invalid_group' } });
    const { cfg, tokenId } = await enrollConfig(admin, 1);
    const body = enrollBody(newDev(), cfg, tokenId);
    body.deviceKeyProof = base64urlEncode(new Uint8Array(64));
    expect((await call(t.app, '/api/v1/devices/enroll', { body })).json()).toMatchObject({ error: { code: 'token_bad_signature' } });
    // a p3 token is never accepted for enrollment (no enroll config for it)
    const p3 = await createToken(t.app, admin, { tier: 'p3_portable', typ: 'one_time' });
    expect((await call(t.app, `/api/v1/devices/enroll-config?tokenId=${p3.token.id}`, { cookie: admin.cookie })).json()).toMatchObject({ error: { code: 'invalid_token_type' } });
  });

  it('/signal/device: Origin refused; assist.hello closes 4403; bad signature and disabled close 4412', async () => {
    await expect(SignalClient.open(url.replace(/\/signal$/, '/signal/device'))).rejects.toThrow(/403/);
    const d = await enroll(admin);
    const forger = await connect(d, 'locked', true);
    expect((await forger.next('error'))['code']).toBe('device_unauthenticated');
    expect(await forger.closed()).toBe(4412);
    const rogue = await SignalClient.open(url.replace(/\/signal$/, '/signal/device'), { origin: null });
    sockets.push(rogue);
    await rogue.next('device.challenge');
    rogue.send({ t: 'assist.hello' });
    expect((await rogue.next('error'))['code']).toBe('forbidden');
    expect(await rogue.closed()).toBe(4403);
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}/disable`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
    expect((await ws.next('error'))['code']).toBe('device_disabled');
    expect(await ws.closed()).toBe(4412);
    const again = await connect(d);
    expect((await again.next('error'))['code']).toBe('device_disabled');
  });

  it('section 6.2 refusals at POST /devices/:id/sessions', async () => {
    const offline = await enroll(admin);
    expect((await openSession(admin, offline, { unattended: true, reason: 'r' })).json()).toMatchObject({ error: { code: 'device_offline' } });
    // org default: approval_only + nobody present
    const def = await enroll(admin);
    await (await connect(def)).next('device.hello.ok');
    expect((await openSession(admin, def, { unattended: true, reason: 'r' })).json()).toMatchObject({ error: { code: 'approval_required' } });
    expect((await openSession(admin, def, { unattended: false })).json()).toMatchObject({ error: { code: 'nobody_present' } });
    const deny = await enroll(admin, { groupId: await group(admin, { mode: 'deny' }) });
    await (await connect(deny)).next('device.hello.ok');
    expect((await openSession(admin, deny, { unattended: true, reason: 'r' })).json()).toMatchObject({ error: { code: 'unattended_denied' } });
    const allowGroup = await group(admin, { mode: 'allow', recordingRequired: false });
    const pre = await enroll(admin, { groupId: allowGroup });
    await (await connect(pre, 'none')).next('device.hello.ok');
    expect((await openSession(admin, pre, { unattended: true, reason: 'r' })).json()).toMatchObject({ error: { code: 'prelogin_not_permitted' } });
    const rec = await enroll(admin, { groupId: await group(admin, { mode: 'allow', recordingRequired: true }) });
    await (await connect(rec)).next('device.hello.ok');
    expect((await openSession(admin, rec, { unattended: true, reason: 'r' })).json()).toMatchObject({ error: { code: 'recorder_required' } });
    // allow + nobody present -> 201, and a second open -> device_busy
    const ok = await enroll(admin, { groupId: allowGroup });
    const ws = await connect(ok);
    await ws.next('device.hello.ok');
    const r = await openSession(admin, ok, { unattended: true, reason: 'maintenance' });
    expect(r.statusCode, r.body).toBe(201);
    const open = await ws.next('device.session_open');
    expect(open['decision']).toBe('auto_grant');
    expect((await openSession(admin, ok, { unattended: true, reason: 'x' })).json()).toMatchObject({ error: { code: 'device_busy', details: { sessionId: (r.json() as { sessionId: string }).sessionId } } });
    // the worker's features must be a subset of the device's
    const worker = await SignalClient.open(url, { origin: null });
    sockets.push(worker);
    worker.send({
      t: 'desk.hello',
      workerCredential: open['workerCredential'],
      client: { kind: 'native', version: '0.4.0', os: 'windows', platform: { osVersion: '10.0', arch: 'x64' }, tokenSource: 'service', capabilities: { monitors: 1, elevation: 'admin', features: ['screen', 'voice'], encoders: ['vp8'], hwEncoder: false, interpreters: [] } },
    });
    expect((await worker.next('error'))['code']).toBe('capability_mismatch');
    expect(await worker.closed()).toBe(4403);
  });

  it('fleet RBAC: cross-org 404, auditor read-only, observer cannot act, scoping on with [] / a group', async () => {
    const d = await enroll(admin);
    const other = await signup(t.app);
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: other.cookie })).statusCode).toBe(404);
    const auditor = await addMember(t.app, admin, 'auditor');
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: auditor.cookie })).statusCode).toBe(200);
    expect((await openSession(auditor, d, { unattended: false })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}/disable`, { cookie: auditor.cookie, body: {} })).statusCode).toBe(403);
    const observer = await addMember(t.app, admin, 'observer');
    expect((await call(t.app, '/api/v1/devices', { cookie: observer.cookie })).statusCode).toBe(200);
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}/actions`, { cookie: observer.cookie })).statusCode).toBe(403);
    const tech = await addMember(t.app, admin, 'technician');
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: tech.cookie })).statusCode).toBe(200);
    await call(t.app, '/api/v1/orgs/current/policy/fleet', { method: 'PATCH', cookie: admin.cookie, body: { fleetScopingEnabled: true } });
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: tech.cookie })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/devices', { cookie: tech.cookie })).json()).toMatchObject({ items: [] });
    const g = await group(admin, {});
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { method: 'PATCH', cookie: admin.cookie, body: { groupId: g } })).statusCode).toBe(200);
    const put = await call(t.app, `/api/v1/orgs/current/users/${tech.user.id}/device-groups`, { method: 'PUT', cookie: admin.cookie, body: { groupIds: [g] } });
    expect(put.json()).toMatchObject({ deviceGroupIds: [g] });
    expect((await call(t.app, `/api/v1/devices/${d.deviceId}`, { cookie: tech.cookie })).statusCode).toBe(200);
    await call(t.app, '/api/v1/orgs/current/policy/fleet', { method: 'PATCH', cookie: admin.cookie, body: { fleetScopingEnabled: false } });
  });

  it('actions: deny refuses at POST except message; a privileged playbook needs a reason', async () => {
    const d = await enroll(admin, { groupId: await group(admin, { mode: 'deny' }) });
    const path = `/api/v1/devices/${d.deviceId}/actions`;
    expect((await call(t.app, path, { cookie: admin.cookie, body: { kind: 'file_push', payload: { fileRef: 'https://s3.example/x', name: 'a.txt', bytes: 1, sha256: 'a'.repeat(64) } } })).json()).toMatchObject({ error: { code: 'unattended_denied' } });
    const m = await call(t.app, path, { cookie: admin.cookie, body: { kind: 'message', payload: { title: 'Hi', body: 'later' } } });
    expect(m.statusCode, m.body).toBe(202);
    expect(m.json()).toMatchObject({ state: 'queued' });
    expect((await call(t.app, path, { cookie: admin.cookie, body: { kind: 'playbook_run', payload: { playbookId: '00000000-0000-4000-8000-000000000000', args: {}, requiresElevation: true } } })).statusCode).toBe(400);
    const cancel = await call(t.app, `${path}/${(m.json() as { actionId: string }).actionId}/cancel`, { cookie: admin.cookie, body: {} });
    expect(cancel.json()).toMatchObject({ state: 'cancelled' });
  });
});
