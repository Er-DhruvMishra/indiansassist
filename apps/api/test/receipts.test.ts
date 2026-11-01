/**
 * Phase D consent receipts (docs/specs/phase-d-contracts.md section 6.4, section 15.3 "the email channel, the
 * `device.notify_email ?? group ?? null` fallback and the `consent.receipt_sent` causes"): both channels of rule
 * 6.4b against a live app -- the device copy (pushed when it is connected, held and re-sent at the next check-in
 * when it is not) and the mail of rule 6.4c/6.4d -- the address fallback order (the device's own address, else its
 * group's, else none), and every `consent.receipt_sent` cause the server can record: `no_address`, `no_mailer` (the
 * `log` driver of a self-host without SMTP), `send_failed`, and a plain delivery. The session receipt itself is
 * built from the chain, so the mail of an unattended session carries what the chain says happened.
 */
import { getOrg } from '@indiansassist/db';
import { listAuditByOrgPaginated } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, type Account, type Msg, type SignalClient, type TestApp } from './helpers.js';
import { connectDevice, deviceGroup, enrollDevice, makeP4App, openDeviceSessionVia, p4Admin, workerConsent, workerHelloWith, type Dev } from './p4-kit.js';
import { flushAllDigests } from '../src/fleet/receipts.js';
import { piiHash } from '../src/lib/audit.js';
import type { Mailer, MailMessage } from '../src/mail/mailer.js';

type Entry = { data: Record<string, unknown>; actorType: string };

describe('consent receipts: the device copy, the mail and its causes (section 6.4)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  let group: string;
  let pepper: { auditPepper: string };
  const sockets: SignalClient[] = [];
  const sent: MailMessage[] = [];

  const logMailer = () => {
    t.ctx.mailer = { driver: 'log', async send(m) { sent.push(m); return true; } } satisfies Mailer;
  };
  const smtpMailer = () => {
    t.ctx.mailer = { driver: 'smtp', async send(m) { sent.push(m); return true; } } satisfies Mailer;
  };
  const brokenMailer = () => {
    t.ctx.mailer = { driver: 'smtp', async send() { throw new Error('connect ECONNREFUSED 10.0.0.1:587'); } } satisfies Mailer;
  };

  const receipts = async (channel: 'device' | 'email'): Promise<Entry[]> =>
    ((await listAuditByOrgPaginated(t.ctx.db, admin.org.id, { action: 'consent.receipt_sent', limit: 200 })).items as unknown as Entry[]).filter(
      (e) => e.data['channel'] === channel,
    );
  const lastEmail = async (): Promise<Entry> => (await receipts('email'))[0]!;
  const setGroupEmail = (email: string | null) =>
    call(t.app, `/api/v1/orgs/current/device-groups/${group}`, { method: 'PATCH', cookie: admin.cookie, body: { notifyEmail: email } });
  const setDeviceEmail = (d: Dev, email: string | null) =>
    call(t.app, `/api/v1/devices/${d.deviceId}`, { method: 'PATCH', cookie: admin.cookie, body: { notifyEmail: email } });
  /** A finished action, the cheapest receipt there is: queue a message, cancel it, then flush the mail digest. */
  const finishedAction = async (d: Dev, title: string) => {
    const r = await call(t.app, `/api/v1/devices/${d.deviceId}/actions`, { cookie: admin.cookie, body: { kind: 'message', payload: { title, body: 'please call us' } } });
    expect(r.statusCode, r.body).toBe(202);
    const actionId = (r.json() as { actionId: string }).actionId;
    const c = await call(t.app, `/api/v1/devices/${d.deviceId}/actions/${actionId}/cancel`, { cookie: admin.cookie, body: {} });
    expect(c.statusCode, c.body).toBe(200);
    return actionId;
  };

  beforeAll(async () => {
    t = await makeP4App();
    url = await listen(t.app);
    admin = await p4Admin(t);
    group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
    pepper = (await getOrg(t.ctx.db, admin.org.id))!;
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('the device channel: pushed while it is connected, held and re-sent at the next check-in', async () => {
    const d = await enrollDevice(t, admin, { groupId: group });
    // Offline: the receipt cannot be delivered, so it is held and the chain says so honestly.
    const actionId = await finishedAction(d, 'While it sleeps');
    const held = (await receipts('device'))[0]!;
    expect(held.data).toMatchObject({ channel: 'device', delivered: false, actionIds: [actionId], toHash: null, sessionId: null });
    expect(held.actorType).toBe('system');

    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    const re: Msg = await ws.next('device.receipt');
    expect((re['receipt'] as { actionId: string }).actionId).toBe(actionId);
    const after = await receipts('device');
    expect(after[0]!.data).toMatchObject({ channel: 'device', delivered: true, actionIds: [actionId] });
    expect(after).toHaveLength(2);

    // Online: delivered on the spot, once.
    const second = await finishedAction(d, 'While it is awake');
    expect((((await ws.next('device.receipt'))['receipt']) as { actionId: string }).actionId).toBe(second);
    const now = (await receipts('device'))[0]!;
    expect(now.data).toMatchObject({ delivered: true, actionIds: [second] });
    // Nothing is held for a device that took it: the next check-in does not repeat it.
    ws.close();
    await t.ctx.presence.delKey(`ia:dev:${d.deviceId}`);
    const back = await connectDevice(url, d, { track: sockets });
    await back.next('device.hello.ok');
    expect(await back.quiet('device.receipt', 300)).toBe(true);
  });

  it('the mail: no address, the group address, then the device address (rule 6.4c)', async () => {
    const d = await enrollDevice(t, admin, { groupId: group });
    sent.length = 0;
    logMailer();

    // (1) Neither the device nor its group has an address: nothing is sent, and the cause names why.
    await finishedAction(d, 'No address');
    await flushAllDigests(t.ctx);
    expect((await lastEmail()).data).toMatchObject({ channel: 'email', delivered: false, cause: 'no_address', toHash: null });
    expect(sent).toHaveLength(0);

    // (2) The group's address is the fallback.
    expect((await setGroupEmail('fleet-desk@example.test')).statusCode).toBe(200);
    await finishedAction(d, 'Group address');
    await flushAllDigests(t.ctx);
    expect((await lastEmail()).data).toMatchObject({ channel: 'email', toHash: piiHash(pepper, 'fleet-desk@example.test') });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('fleet-desk@example.test');

    // (3) The device's own address wins over its group's.
    expect((await setDeviceEmail(d, 'Owner@Example.Test')).statusCode).toBe(200);
    await finishedAction(d, 'Device address');
    await flushAllDigests(t.ctx);
    // Rule 6.4c: only the peppered hash of the normalised address reaches the chain, never the address.
    const toDevice = await lastEmail();
    expect(toDevice.data['toHash']).toBe(piiHash(pepper, 'owner@example.test'));
    expect(JSON.stringify(toDevice)).not.toContain('Owner@Example.Test');
    expect(JSON.stringify(toDevice)).not.toContain('owner@example.test');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe('Owner@Example.Test');
    expect(sent[1]!.subject).toContain('PC');
    expect(sent[1]!.attachments.map((a) => a.name)).toEqual(['receipt.json']);

    // (4) Clearing the device address falls back to the group again.
    expect((await setDeviceEmail(d, null)).statusCode).toBe(200);
    await finishedAction(d, 'Back to the group');
    await flushAllDigests(t.ctx);
    expect((await lastEmail()).data['toHash']).toBe(piiHash(pepper, 'fleet-desk@example.test'));
    await setGroupEmail(null);
  });

  it('every delivery cause: no_mailer on the log driver, send_failed on a broken transport, else delivered', async () => {
    const d = await enrollDevice(t, admin, { groupId: group });
    await setDeviceEmail(d, 'owner2@example.test');
    sent.length = 0;

    // The `log` driver is a self-host without SMTP: the receipt is written to the log, not delivered.
    logMailer();
    await finishedAction(d, 'Log driver');
    await flushAllDigests(t.ctx);
    expect((await lastEmail()).data).toMatchObject({ channel: 'email', delivered: false, cause: 'no_mailer' });
    expect(sent).toHaveLength(1);

    // A real transport that fails is `send_failed`, not a lost receipt and not an exception out of the sweep.
    brokenMailer();
    await finishedAction(d, 'Broken transport');
    await flushAllDigests(t.ctx);
    expect((await lastEmail()).data).toMatchObject({ channel: 'email', delivered: false, cause: 'send_failed' });

    // A working transport: delivered, with no cause at all.
    smtpMailer();
    const actionId = await finishedAction(d, 'Working transport');
    await flushAllDigests(t.ctx);
    const ok = await lastEmail();
    expect(ok.data).toMatchObject({ channel: 'email', delivered: true, actionIds: [actionId] });
    expect(ok.data['cause']).toBeUndefined();
    expect(sent.at(-1)!.to).toBe('owner2@example.test');
    // The digest is per device and carries the actions it batched.
    const text = sent.at(-1)!.text;
    expect(text).toContain('Working transport');
    expect(JSON.parse(JSON.stringify(sent.at(-1)!.attachments[0]!.json))).toHaveLength(1);
  });

  it('an unattended session is mailed too, with the receipt the chain supports', async () => {
    const d = await enrollDevice(t, admin, { groupId: group });
    await setDeviceEmail(d, 'owner3@example.test');
    sent.length = 0;
    smtpMailer();
    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    const { sessionId, open } = await openDeviceSessionVia(t, admin, d, ws, { unattended: true, reason: 'patch the spooler' });
    expect(open['decision']).toBe('auto_grant');
    const worker = await workerHelloWith(url, open['workerCredential'], { track: sockets });
    await worker.next('desk.hello.ok');
    expect((await workerConsent(worker))['state']).toBe('active');
    const end = await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
    expect(end.statusCode, end.body).toBe(200);

    // The device copy, built from this session's chain.
    const re = (await ws.next('device.receipt'))['receipt'] as Record<string, unknown>;
    expect(re).toMatchObject({
      sessionId,
      deviceId: d.deviceId,
      unattended: true,
      approvedBy: 'policy',
      reason: 'patch the spooler',
      endReason: 'assist_ended',
    });
    expect((re['policySnapshot'] as { mode: string }).mode).toBe('allow');
    expect(typeof re['hashChainTail']).toBe('string');
    // And the mail, which only an unattended session the policy authorised gets (rule 6.4c).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('owner3@example.test');
    expect(sent[0]!.text).toContain('patch the spooler');
    expect((sent[0]!.attachments[0]!.json as { sessionId: string }).sessionId).toBe(sessionId);
    const email = await lastEmail();
    expect(email.data).toMatchObject({ channel: 'email', delivered: true, sessionId, actionIds: [] });
    const device = (await receipts('device'))[0]!;
    expect(device.data).toMatchObject({ channel: 'device', delivered: true, sessionId });
  });
});
