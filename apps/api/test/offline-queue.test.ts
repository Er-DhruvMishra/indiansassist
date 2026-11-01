/**
 * Phase D offline action queue (docs/specs/phase-d-contracts.md section 9, section 15.3 "`awaiting_approval`, the
 * `allowedHours` hold and the expiry sweep against a live server"): the three rule 9.9 outcomes the smoke does not
 * reach, driven over the real REST routes and the real `/signal/device` socket of a live app -- an action that waits
 * for someone at the device (`awaiting_approval` -> `running { approvedBy }` -> `done`, each step device-signed and
 * chained), an action held outside `allowedHours` (not dispatched, not drained at the next check-in, dispatched by
 * the sweeper once the window opens) and the expiry sweep (`queued` and `awaiting_approval` rows past `expires_at`
 * go `expired` and each gets its receipt).
 */
import { deviceAction, getDeviceAction, listAuditByOrgPaginated } from '@indiansassist/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, type Account, type Msg, type SignalClient, type TestApp } from './helpers.js';
import {
  actionResultFrame,
  connectDevice,
  deviceGroup,
  enrollDevice,
  makeP4App,
  p4Admin,
  type Dev,
} from './p4-kit.js';
import { fleetSweep } from '../src/fleet/sweep.js';
import { Sweeper } from '../src/sweeper.js';

const FILE_PUSH = { fileRef: 'https://files.example.test/patch.msi', name: 'patch.msi', bytes: 2048, sha256: 'c'.repeat(64) };

/** An `allowedHours` with one window that does NOT contain `now` in UTC (and one that does, for the release). */
function windowsAround(now: Date): { outside: Record<string, unknown>; inside: Record<string, unknown> } {
  const hhmm = now.toISOString().slice(11, 16);
  const days = [1, 2, 3, 4, 5, 6, 7];
  const early = { days, from: '01:00', to: '02:00' };
  const late = { days, from: '15:00', to: '16:00' };
  const contains = (w: { from: string; to: string }) => w.from <= hhmm && hhmm < w.to;
  return {
    outside: { tz: 'UTC', windows: [contains(early) ? late : early] },
    inside: { tz: 'UTC', windows: [{ days, from: '00:00', to: '23:59' }] },
  };
}

describe('the offline action queue against a live server (section 9)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  const sockets: SignalClient[] = [];

  const actionsPath = (d: Dev) => `/api/v1/devices/${d.deviceId}/actions`;
  const queue = (d: Dev, body: Record<string, unknown>) => call(t.app, actionsPath(d), { cookie: admin.cookie, body });
  const list = async (d: Dev) =>
    ((await call(t.app, actionsPath(d), { cookie: admin.cookie })).json() as { items: { id: string; state: string; approvedBy: string | null }[] }).items;
  const audit = async (action: string) => (await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action })).items;
  const patchPolicy = (d: Dev, unattendedPolicy: Record<string, unknown> | null) =>
    call(t.app, `/api/v1/devices/${d.deviceId}`, { method: 'PATCH', cookie: admin.cookie, body: { unattendedPolicy } });
  const online = async (d: Dev) => {
    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    return ws;
  };

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('awaiting_approval: the action waits for someone at the device, then runs with who approved it', async () => {
    // `approval_only` with nobody present is the rule 9.9 `approval { waitForPresence: true }` row.
    const group = await deviceGroup(t, admin, { mode: 'approval_only', recordingRequired: false });
    const d = await enrollDevice(t, admin, { groupId: group });
    const ws = await online(d);
    const r = await queue(d, { kind: 'file_push', payload: FILE_PUSH, reason: 'install the printer patch' });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ state: 'dispatched' });
    const actionId = (r.json() as { actionId: string }).actionId;
    const frame: Msg = await ws.next('device.action');
    expect(frame).toMatchObject({ actionId, kind: 'file_push', reason: 'install the printer patch' });
    expect(frame['technician']).toMatchObject({ name: expect.any(String) });

    // The device asks the person at the console and tells us it is waiting.
    ws.send(actionResultFrame(d, { actionId, state: 'awaiting_approval' }));
    await expect.poll(async () => (await getDeviceAction(t.ctx.db, actionId))?.state).toBe('awaiting_approval');
    expect((await list(d)).find((a) => a.id === actionId)).toMatchObject({ state: 'awaiting_approval', approvedBy: null });
    // Nothing is chained for the wait itself: `device.action_started` is the step that records who approved it.
    expect(await audit('device.action_started')).toHaveLength(0);

    ws.send(actionResultFrame(d, { actionId, state: 'running', approvedBy: 'local_user' }));
    await expect.poll(async () => (await getDeviceAction(t.ctx.db, actionId))?.state).toBe('running');
    expect((await audit('device.action_started'))[0]?.data).toMatchObject({ actionId, deviceId: d.deviceId, approvedBy: 'local_user' });
    expect((await audit('device.action_started'))[0]?.actorType).toBe('device');
    expect((await list(d)).find((a) => a.id === actionId)).toMatchObject({ state: 'running', approvedBy: 'local_user' });

    ws.send(actionResultFrame(d, { actionId, state: 'done', result: { exit: 0, ranAs: 'admin' } }));
    await expect.poll(async () => (await getDeviceAction(t.ctx.db, actionId))?.state).toBe('done');
    const completed = (await audit('device.action_completed'))[0];
    expect(completed?.data).toMatchObject({ actionId, state: 'done', exit: 0, ranAs: 'admin' });
    const row = await getDeviceAction(t.ctx.db, actionId);
    expect(row).toMatchObject({ approvedBy: 'local_user', result: { exit: 0, ranAs: 'admin' } });
    expect(row?.completedAt).not.toBeNull();
    // Every finished action produces a receipt, and this one reaches the device that is still connected.
    const receipt = await ws.next('device.receipt');
    expect((receipt['receipt'] as { actionId: string; state: string; approvedBy: string }).actionId).toBe(actionId);
    expect(receipt['receipt']).toMatchObject({ state: 'done', approvedBy: 'local_user', kind: 'file_push' });

    // A finished action is final: a later result for it changes nothing and chains nothing.
    const chained = (await audit('device.action_completed')).length;
    ws.send(actionResultFrame(d, { actionId, state: 'failed' }));
    expect(await ws.quiet('device.receipt', 300)).toBe(true);
    expect((await getDeviceAction(t.ctx.db, actionId))?.state).toBe('done');
    expect((await audit('device.action_completed')).length).toBe(chained);
    const second = await queue(d, { kind: 'file_push', payload: FILE_PUSH, reason: 'again' });
    const id2 = (second.json() as { actionId: string }).actionId;
    await ws.next('device.action', (m) => m['actionId'] === id2);
    ws.send({ ...actionResultFrame(d, { actionId: id2, state: 'running', approvedBy: 'local_user' }), approvedBy: 'policy' });
    expect((await ws.next('error'))['code']).toBe('device_bad_signature');
    expect((await getDeviceAction(t.ctx.db, id2))?.state).toBe('dispatched');
    // A waiting action can still be cancelled from the console (the transition allows `awaiting_approval`).
    ws.send(actionResultFrame(d, { actionId: id2, state: 'awaiting_approval' }));
    await expect.poll(async () => (await getDeviceAction(t.ctx.db, id2))?.state).toBe('awaiting_approval');
    const cancelled = await call(t.app, `${actionsPath(d)}/${id2}/cancel`, { cookie: admin.cookie, body: {} });
    expect(cancelled.json()).toMatchObject({ state: 'cancelled' });
  });

  it('the allowedHours hold: queued, not dispatched, not drained, then sent when the window opens', async () => {
    const hours = windowsAround(new Date());
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false, allowedHours: hours.outside });
    const d = await enrollDevice(t, admin, { groupId: group });
    const ws = await online(d);
    const r = await queue(d, { kind: 'file_push', payload: FILE_PUSH, reason: 'outside the window' });
    expect(r.statusCode, r.body).toBe(202);
    // Rule 9.9 `hold`: accepted at POST, held at dispatch -- the device is online and still gets nothing.
    expect(r.json()).toMatchObject({ state: 'queued' });
    const actionId = (r.json() as { actionId: string }).actionId;
    expect(await ws.quiet('device.action', 400)).toBe(true);
    expect(await getDeviceAction(t.ctx.db, actionId)).toMatchObject({ state: 'queued', dispatchedAt: null });
    expect((await audit('device.action_dispatched')).filter((e) => (e.data as { actionId: string }).actionId === actionId)).toHaveLength(0);
    // Nor is it handed over at the next check-in: the hold is re-evaluated on the drain path too.
    ws.close();
    await t.ctx.presence.delKey(`ia:dev:${d.deviceId}`);
    const back = await connectDevice(url, d, { track: sockets });
    expect((await back.next('device.hello.ok'))['queued']).toEqual([]);
    expect(await back.quiet('device.action', 400)).toBe(true);
    expect(await getDeviceAction(t.ctx.db, actionId)).toMatchObject({ state: 'queued' });

    // The window opens (here as a device override): the sweeper's re-dispatch pass sends it without a new POST.
    const patched = await patchPolicy(d, { allowedHours: hours.inside });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await back.next('device.policy'))['policy']).toMatchObject({ allowedHours: hours.inside });
    await new Sweeper(t.ctx).runOnce();
    const frame = await back.next('device.action');
    expect(frame['actionId']).toBe(actionId);
    expect(await getDeviceAction(t.ctx.db, actionId)).toMatchObject({ state: 'dispatched' });
    expect((await audit('device.action_dispatched')).some((e) => (e.data as { actionId: string }).actionId === actionId)).toBe(true);
    // `message` is never gated: it goes out even while the hold is on.
    await patchPolicy(d, { allowedHours: hours.outside });
    await back.next('device.policy');
    const note = await queue(d, { kind: 'message', payload: { title: 'Patching tonight', body: 'Please leave the machine on.' } });
    expect(note.json()).toMatchObject({ state: 'dispatched' });
    expect((await back.next('device.action', (m) => m['kind'] === 'message'))['kind']).toBe('message');
  });

  it('the expiry sweep: queued and waiting actions past expires_at go expired, each with its receipt', async () => {
    const group = await deviceGroup(t, admin, { mode: 'approval_only', recordingRequired: false });
    const d = await enrollDevice(t, admin, { groupId: group });
    // One action queued while the device is offline, one waiting for approval with the device connected.
    const offline = await queue(d, { kind: 'file_push', payload: FILE_PUSH, reason: 'while it sleeps' });
    expect(offline.json()).toMatchObject({ state: 'queued' });
    const queuedId = (offline.json() as { actionId: string }).actionId;
    const ws = await online(d);
    const waiting = await queue(d, { kind: 'file_push', payload: FILE_PUSH, reason: 'waiting for the user' });
    const waitingId = (waiting.json() as { actionId: string }).actionId;
    await ws.next('device.action', (m) => m['actionId'] === waitingId);
    ws.send(actionResultFrame(d, { actionId: waitingId, state: 'awaiting_approval' }));
    await expect.poll(async () => (await getDeviceAction(t.ctx.db, waitingId))?.state).toBe('awaiting_approval');
    // The queued one was drained on the hello, so put it back where the sweep expects to find it.
    await t.ctx.db.update(deviceAction).set({ state: 'queued', dispatchedAt: null }).where(eq(deviceAction.id, queuedId));

    const expired = new Date(Date.now() - 60_000);
    await t.ctx.db.update(deviceAction).set({ expiresAt: expired }).where(inArray(deviceAction.id, [queuedId, waitingId]));
    const before = (await audit('consent.receipt_sent')).length;
    await fleetSweep(t.ctx);

    for (const id of [queuedId, waitingId]) {
      const row = await getDeviceAction(t.ctx.db, id);
      expect(row?.state, id).toBe('expired');
      expect(row?.completedAt).not.toBeNull();
    }
    expect((await list(d)).filter((a) => a.state === 'expired')).toHaveLength(2);
    // Section 6.4: an expiry is an outcome like any other, so each one is receipted.
    const receipts = (await audit('consent.receipt_sent')).slice(0, 2);
    expect(receipts).toHaveLength(2);
    expect((await audit('consent.receipt_sent')).length).toBe(before + 2);
    for (const r of receipts) expect(r.data).toMatchObject({ channel: 'device', sessionId: null });
    const states: string[] = [];
    for (let i = 0; i < 2; i++) states.push(((await ws.next('device.receipt'))['receipt'] as { state: string }).state);
    expect(states).toEqual(['expired', 'expired']);
    // The sweep is idempotent: a second pass finds nothing to expire and writes no further receipt.
    const after = (await audit('consent.receipt_sent')).length;
    await fleetSweep(t.ctx);
    expect((await audit('consent.receipt_sent')).length).toBe(after);
    // And an expired action is final: the console cannot cancel it.
    expect((await call(t.app, `${actionsPath(d)}/${queuedId}/cancel`, { cookie: admin.cookie, body: {} })).statusCode).toBe(409);
  });
});
