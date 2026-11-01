/**
 * Phase D observability (docs/specs/phase-d-contracts.md section 13.5): the seven fleet series on the existing
 * prom-client registry. Every series is asserted on the body the `/metrics` endpoint serves (`registry.metrics()`)
 * with the label names the contract gives it, zero-initialised at boot, and then moved by driving the real paths:
 * a `/signal/device` hello (good, bad-signature and disabled), a heartbeat, an action through queued -> dispatched ->
 * running -> done plus a cancel, its receipts on the device and email channels, a WoL wake that fails `no_waker` and
 * one confirmed by the target's next hello, and a signed tamper event.
 */
import { randomUUID } from 'node:crypto';
import { deviceSigInput, signDeviceInput } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flushAllDigests } from '../src/fleet/receipts.js';
import { DEVICE_HELLO_RESULTS } from '../src/lib/metrics.js';
import { call, listen, type Account, type SignalClient, type TestApp } from './helpers.js';
import { connectDevice, deviceGroup, enrollDevice, makeP4App, newDev, p4Admin, SERVICE_FEATURES_BASE, type Dev } from './p4-kit.js';

/** One sample of `name` carrying exactly `labels`, or null when the series is not exposed. */
function sample(body: string, name: string, labels: Record<string, string> = {}): number | null {
  const want = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .sort()
    .join(',');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const got = (m[2] ?? '')
      .split(',')
      .filter((x) => x !== '')
      .sort()
      .join(',');
    if (got === want) return Number(m[3]);
  }
  return null;
}

describe('phase D fleet metrics (section 13.5)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  let allowGroup: string;
  const sockets: SignalClient[] = [];
  const body = () => t.ctx.metrics.registry.metrics();
  const connect = (d: Dev, opts: Parameters<typeof connectDevice>[2] = {}) => connectDevice(url, d, { ...opts, track: sockets });

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
    allowGroup = await deviceGroup(t, admin, { mode: 'allow', requireLocalApprovalWhenPresent: false });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('registers the seven series on the existing registry, zero-initialised with the contract labels', async () => {
    const text = await body();
    for (const name of [
      'ia_devices_connected',
      'ia_device_hello_total',
      'ia_device_heartbeat_lag_seconds',
      'ia_wake_attempts_total',
      'ia_device_actions_total',
      'ia_tamper_alerts_total',
      'ia_receipts_sent_total',
    ])
      expect(text, `${name} HELP line`).toContain(`# HELP ${name} `);
    // The A/B/C series are still there (the fleet series were added beside them, not in place of them).
    for (const name of ['ia_ws_connections', 'ia_sessions_active', 'ia_audit_entries_total', 'ia_rate_limited_total', 'ia_recorder_connections'])
      expect(sample(text, name), name).not.toBeNull();

    expect(sample(text, 'ia_devices_connected')).toBe(0);
    for (const result of DEVICE_HELLO_RESULTS) expect(sample(text, 'ia_device_hello_total', { result }), `hello ${result}`).toBe(0);
    expect(sample(text, 'ia_device_heartbeat_lag_seconds_count')).toBe(0);
    expect(sample(text, 'ia_device_heartbeat_lag_seconds_bucket', { le: '35' })).toBe(0);
    for (const method of ['wol', 'amt'])
      for (const result of ['woke', 'no_waker', 'no_confirm', 'amt_unavailable', 'amt_unreachable', 'waker_error'])
        expect(sample(text, 'ia_wake_attempts_total', { method, result }), `wake ${method}/${result}`).toBe(0);
    for (const kind of ['playbook_run', 'file_push', 'print', 'message'])
      for (const state of ['queued', 'dispatched', 'awaiting_approval', 'running', 'done', 'failed', 'cancelled', 'expired'])
        expect(sample(text, 'ia_device_actions_total', { kind, state }), `action ${kind}/${state}`).toBe(0);
    for (const cause of ['stopped', 'disabled', 'deleted', 'binary_changed', 'config_changed', 'watchdog_restarted', 'suspected'])
      expect(sample(text, 'ia_tamper_alerts_total', { cause }), `tamper ${cause}`).toBe(0);
    for (const channel of ['device', 'email'])
      for (const delivered of ['true', 'false']) expect(sample(text, 'ia_receipts_sent_total', { channel, delivered }), `receipt ${channel}/${delivered}`).toBe(0);
  });

  it('counts device connections, every hello outcome and the heartbeat lag', async () => {
    const d = await enrollDevice(t, admin, { groupId: allowGroup });
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    expect(sample(await body(), 'ia_devices_connected')).toBe(1);
    expect(sample(await body(), 'ia_device_hello_total', { result: 'ok' })).toBe(1);

    const bad = await connect(d, { badSig: true });
    expect((await bad.next('error')).code).toBe('device_unauthenticated');
    expect(sample(await body(), 'ia_device_hello_total', { result: 'unauthenticated' })).toBe(1);
    // The refused socket never counted as connected: the helloed one is still the only connection.
    expect(sample(await body(), 'ia_devices_connected')).toBe(1);

    ws.send({ t: 'device.heartbeat' });
    await ws.request({ t: 'ping' }, 'pong'); // the heartbeat is handled before this reply (one queue per socket)
    expect(sample(await body(), 'ia_device_heartbeat_lag_seconds_count')).toBe(1);
    expect(sample(await body(), 'ia_device_heartbeat_lag_seconds_bucket', { le: '15' })).toBe(1);

    const disabled = await enrollDevice(t, admin, { groupId: allowGroup });
    expect((await call(t.app, `/api/v1/devices/${disabled.deviceId}/disable`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
    const off = await connect(disabled);
    expect((await off.next('error')).code).toBe('device_disabled');
    expect(sample(await body(), 'ia_device_hello_total', { result: 'disabled' })).toBe(1);

    ws.close();
    await ws.closed();
    await new Promise((r) => setTimeout(r, 300));
    expect(sample(await body(), 'ia_devices_connected')).toBe(0);
  });

  it('counts device actions by kind and state, and receipts by channel and delivery', async () => {
    const d = await enrollDevice(t, admin, { groupId: allowGroup });
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    const path = `/api/v1/devices/${d.deviceId}/actions`;
    const res = await call(t.app, path, { cookie: admin.cookie, body: { kind: 'message', payload: { title: 'IT', body: 'We will connect shortly' } } });
    expect(res.statusCode, res.body).toBe(202);
    const { actionId } = res.json() as { actionId: string };
    await ws.next('device.action', (m) => m['actionId'] === actionId);
    expect(sample(await body(), 'ia_device_actions_total', { kind: 'message', state: 'queued' })).toBe(1);
    expect(sample(await body(), 'ia_device_actions_total', { kind: 'message', state: 'dispatched' })).toBe(1);

    for (const state of ['running', 'done'] as const) {
      const frame = { actionId, state, approvedBy: 'policy' as const, ...(state === 'done' ? { result: { exit: 0 } } : {}) };
      ws.send({ t: 'device.action_result', ...frame, sig: signDeviceInput(deviceSigInput.action({ deviceId: d.deviceId, ...frame }), d.seed) });
    }
    await ws.next('device.receipt', (m) => (m['receipt'] as { actionId?: string }).actionId === actionId);
    const afterDone = await body();
    expect(sample(afterDone, 'ia_device_actions_total', { kind: 'message', state: 'running' })).toBe(1);
    expect(sample(afterDone, 'ia_device_actions_total', { kind: 'message', state: 'done' })).toBe(1);
    // Rule 6.4b: the device channel delivered (its socket is open).
    expect(sample(afterDone, 'ia_receipts_sent_total', { channel: 'device', delivered: 'true' })).toBe(1);

    // The mail digest: no notify address on the device or its group, so the email channel is honest about it.
    await flushAllDigests(t.ctx);
    expect(sample(await body(), 'ia_receipts_sent_total', { channel: 'email', delivered: 'false' })).toBe(1);

    const second = await call(t.app, path, { cookie: admin.cookie, body: { kind: 'message', payload: { title: 'IT', body: 'Ignore this one' } } });
    const other = (second.json() as { actionId: string }).actionId;
    expect((await call(t.app, `${path}/${other}/cancel`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
    expect(sample(await body(), 'ia_device_actions_total', { kind: 'message', state: 'cancelled' })).toBe(1);
    ws.close();
  });

  it('counts wake attempts by method and result', async () => {
    const lonely = await enrollDevice(t, admin, { groupId: allowGroup });
    const w1 = await call(t.app, `/api/v1/devices/${lonely.deviceId}/wake`, { cookie: admin.cookie, body: { method: 'wol', reason: 'metrics' } });
    expect(w1.statusCode, w1.body).toBe(202);
    expect(w1.json()).toMatchObject({ method: 'wol', via: null });
    expect(sample(await body(), 'ia_wake_attempts_total', { method: 'wol', result: 'no_waker' })).toBe(1);

    // A waker peer in the same segment plus a target whose MAC the server holds: dispatched, then confirmed.
    const waker = newDev([...SERVICE_FEATURES_BASE, 'waker']);
    await enrollDevice(t, admin, { groupId: allowGroup, dev: waker });
    const wakerWs = await connect(waker);
    await wakerWs.next('device.hello.ok');
    const target = await enrollDevice(t, admin, { groupId: allowGroup });
    const targetWs = await connect(target);
    await targetWs.next('device.hello.ok');
    targetWs.send({ t: 'device.heartbeat', wakeMac: 'aabbccddeeff' });
    await targetWs.request({ t: 'ping' }, 'pong');
    targetWs.close();
    await targetWs.closed();
    await new Promise((r) => setTimeout(r, 300));

    const w2 = await call(t.app, `/api/v1/devices/${target.deviceId}/wake`, { cookie: admin.cookie, body: { method: 'wol', reason: 'metrics' } });
    expect(w2.statusCode, w2.body).toBe(202);
    const { wakeId } = w2.json() as { wakeId: string };
    expect(w2.json()).toMatchObject({ via: waker.deviceId });
    expect((await wakerWs.next('wake.send')).wakeId).toBe(wakeId);
    wakerWs.send({ t: 'wake.sent', wakeId, ok: true });
    const again = await connect(target);
    await again.next('device.hello.ok');
    expect(sample(await body(), 'ia_wake_attempts_total', { method: 'wol', result: 'woke' })).toBe(1);
    wakerWs.close();
    again.close();
  });

  it('counts tamper alerts by cause', async () => {
    const d = await enrollDevice(t, admin, { groupId: allowGroup });
    const ws = await connect(d);
    await ws.next('device.hello.ok');
    const ev = { id: randomUUID(), cause: 'stopped' as const, at: new Date().toISOString(), detail: 'service stopped by an administrator' };
    ws.send({ t: 'device.tamper', events: [{ ...ev, sig: signDeviceInput(deviceSigInput.tamper({ deviceId: d.deviceId, event: ev }), d.seed) }] });
    expect((await ws.next('device.tamper.ok')).ids).toEqual([ev.id]);
    expect(sample(await body(), 'ia_tamper_alerts_total', { cause: 'stopped' })).toBe(1);
    // Replaying the same event id chains nothing a second time, so it is counted once.
    ws.send({ t: 'device.tamper', events: [{ ...ev, sig: signDeviceInput(deviceSigInput.tamper({ deviceId: d.deviceId, event: ev }), d.seed) }] });
    await ws.next('device.tamper.ok');
    expect(sample(await body(), 'ia_tamper_alerts_total', { cause: 'stopped' })).toBe(1);
    ws.close();
  });
});
