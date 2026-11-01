/**
 * Phase D test helpers (docs/specs/phase-d-contracts.md sections 3.2, 3.4, 7.2): a P4-plan app and org_admin, a
 * simulated installed service holding its own identity and sealing keys, enrollment with the possession proof of
 * rule 3.2, and a signed `/signal/device` hello. Shared by `p4.test.ts`, `amt.test.ts` and `vault.test.ts` so the
 * enrollment shape lives in one place.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  base64urlDecode,
  base64urlEncode,
  devicePublicKeyOf,
  deviceSigInput,
  kexPublicKeyOf,
  kidOf,
  signDeviceInput,
  type AmtInventory,
  type TamperEvent,
} from '@indiansassist/shared';
import { expect } from 'vitest';
import type { Timing } from '../src/context.js';
import { call, createToken, makeApp, signup, SignalClient, type Account, type AppOpts, type Msg, type TestApp } from './helpers.js';

/** The features every simulated service advertises; `amt_proxy` / `waker` are added per device. */
export const SERVICE_FEATURES_BASE = ['screen', 'input', 'chat', 'service_input'] as const;

/** `ServiceCapabilities` (section 13.1a) for the given feature list. */
export function capsOf(features: readonly string[] = SERVICE_FEATURES_BASE): Record<string, unknown> {
  return {
    monitors: 1,
    elevation: 'admin',
    features: [...features],
    encoders: ['vp8'],
    hwEncoder: false,
    interpreters: ['powershell'],
    serviceVersion: '0.4.0',
  };
}

export const SERVICE_CAPS = capsOf();

/** The same LAN segment every simulated device reports unless a test wants its own (rule 8.2a). */
export const SUBNET = 'a'.repeat(64);

/** One simulated installed service: Ed25519 identity key plus the X25519 sealing key the server seals to. */
export type Dev = {
  seed: Uint8Array;
  kexSecret: Uint8Array;
  publicKey: string;
  kex: string;
  keyId: string;
  features: string[];
  deviceId: string;
};

export function newDev(features: readonly string[] = SERVICE_FEATURES_BASE): Dev {
  const seed = new Uint8Array(randomBytes(32));
  const kexSecret = new Uint8Array(randomBytes(32));
  const publicKey = devicePublicKeyOf(seed);
  return {
    seed,
    kexSecret,
    publicKey,
    kex: kexPublicKeyOf(kexSecret),
    keyId: kidOf(base64urlDecode(publicKey)),
    features: [...features],
    deviceId: '',
  };
}

export type MachineOpts = { interactive?: string; amt?: AmtInventory | null; wakeMac?: string | null; name?: string };

export function enrollBody(d: Dev, enrollConfig: string, tokenId: string, opts: MachineOpts = {}): Record<string, unknown> {
  return {
    enrollConfig,
    devicePublicKey: d.publicKey,
    deviceKexPublicKey: d.kex,
    deviceKeyProof: signDeviceInput(
      deviceSigInput.enroll({ tokenId, devicePublicKey: d.publicKey, deviceKexPublicKey: d.kex }),
      d.seed,
    ),
    machine: {
      name: opts.name ?? 'PC',
      platform: 'windows',
      osVersion: '10.0',
      arch: 'x64',
      serviceVersion: '0.4.0',
      hwFingerprint: randomBytes(32).toString('hex'),
      wakeMac: opts.wakeMac ?? null,
      amt: opts.amt ?? null,
      capabilities: capsOf(d.features),
      interactive: { state: opts.interactive ?? 'locked', idleSec: null, at: 1 },
    },
  };
}

/** An app whose signups get a P4 plan. */
export function makeP4App(env: Record<string, string> = {}, opts: AppOpts & { timing?: Partial<Timing> } = {}): Promise<TestApp> {
  const { timing = {}, ...rest } = opts;
  return makeApp({ SIGNUP_PLAN_TIER: 'p4_installed', ...env }, timing, rest);
}

/** Signs up an org and raises the admin's seat to `p4_installed`. */
export async function p4Admin(t: TestApp): Promise<Account> {
  const acc = await signup(t.app);
  const r = await call(t.app, `/api/v1/users/${acc.user.id}/role`, {
    method: 'PATCH',
    cookie: acc.cookie,
    body: { role: 'org_admin', tier: 'p4_installed' },
  });
  expect(r.statusCode, r.body).toBe(200);
  return acc;
}

/** A `p4_installed` enrollment token and the region-signed `enroll.iaconfig` for it (section 12.3). */
export async function enrollConfigFor(
  t: TestApp,
  acc: Account,
  maxDevices = 1,
  groupId?: string,
): Promise<{ cfg: string; tokenId: string }> {
  const tok = await createToken(t.app, acc, { tier: 'p4_installed', typ: 'enrollment', maxDevices });
  const res = await call(t.app, `/api/v1/devices/enroll-config?tokenId=${tok.token.id}${groupId ? `&groupId=${groupId}` : ''}`, {
    cookie: acc.cookie,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { cfg: (res.json() as { iaconfig: string }).iaconfig, tokenId: tok.token.id };
}

/** Enrolls one device of `acc`'s org and returns it with its `deviceId` filled in. */
export async function enrollDevice(
  t: TestApp,
  acc: Account,
  opts: MachineOpts & { groupId?: string; dev?: Dev } = {},
): Promise<Dev> {
  const d = opts.dev ?? newDev();
  const { cfg, tokenId } = await enrollConfigFor(t, acc, 1, opts.groupId);
  const res = await call(t.app, '/api/v1/devices/enroll', { body: enrollBody(d, cfg, tokenId, opts) });
  expect(res.statusCode, res.body).toBe(201);
  d.deviceId = (res.json() as { deviceId: string }).deviceId;
  return d;
}

/** A device group with `defaultPolicy` (an `UnattendedPolicyPatch`). */
export async function deviceGroup(t: TestApp, acc: Account, defaultPolicy: Record<string, unknown>): Promise<string> {
  const res = await call(t.app, '/api/v1/orgs/current/device-groups', {
    cookie: acc.cookie,
    body: { name: `g-${randomBytes(3).toString('hex')}`, defaultPolicy },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** The `/signal/device` URL beside the `/signal` one `listen()` returns. */
export function deviceSignalUrl(signalUrl: string): string {
  return signalUrl.replace(/\/signal$/, '/signal/device');
}

/**
 * Opens an Origin-less `/signal/device` socket and answers the challenge with a signed `device.hello`; the caller
 * awaits `device.hello.ok` (or the error, with `badSig`).
 */
export async function connectDevice(
  signalUrl: string,
  d: Dev,
  opts: {
    interactive?: string;
    badSig?: boolean;
    amt?: AmtInventory | null;
    subnetHash?: string;
    /** The wake NIC's MAC this check-in reports (rule 8.2c); omitted reports none, which clears a stored one. */
    wakeMac?: string | null;
    track?: SignalClient[];
  } = {},
): Promise<SignalClient> {
  const ws = await SignalClient.open(deviceSignalUrl(signalUrl), { origin: null });
  opts.track?.push(ws);
  const ch = await ws.next('device.challenge');
  const nonce = base64urlEncode(new Uint8Array(randomBytes(16)));
  const sig = opts.badSig
    ? base64urlEncode(new Uint8Array(64))
    : signDeviceInput(deviceSigInput.hello({ deviceId: d.deviceId, serverChallenge: String(ch['serverChallenge']), nonce }), d.seed);
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
      capabilities: capsOf(d.features),
      lanSegment: { subnetHash: opts.subnetHash ?? SUBNET, gatewayMacHash: 'b'.repeat(64) },
      wakeMac: opts.wakeMac ?? null,
      amt: opts.amt ?? null,
      interactive: { state: opts.interactive ?? 'locked', idleSec: null, at: Date.now() },
    },
  });
  return ws;
}

/**
 * Section 3.5: `POST /devices/:id/sessions` plus the `device.session_open` the device socket receives, so a caller
 * gets the session id and the single-use worker credential in one step.
 */
export async function openDeviceSessionVia(
  t: TestApp,
  acc: Account,
  d: Dev,
  ws: SignalClient,
  body: Record<string, unknown> = { unattended: true, reason: 'kit: maintenance' },
): Promise<{ sessionId: string; open: Msg }> {
  const r = await call(t.app, `/api/v1/devices/${d.deviceId}/sessions`, { cookie: acc.cookie, body });
  expect(r.statusCode, r.body).toBe(201);
  return { sessionId: (r.json() as { sessionId: string }).sessionId, open: await ws.next('device.session_open') };
}

/** The worker's own features: `AGENT_FEATURES` only (a service-only feature in a `desk.hello` is a bad payload). */
export const WORKER_FEATURES_BASE = ['screen', 'input', 'chat'] as const;

/** Section 4.2: the desktop worker's Origin-less `desk.hello { workerCredential }` (no token). */
export async function workerHelloWith(
  signalUrl: string,
  workerCredential: unknown,
  opts: { features?: readonly string[]; track?: SignalClient[] } = {},
): Promise<SignalClient> {
  const ws = await SignalClient.open(signalUrl, { origin: null });
  opts.track?.push(ws);
  ws.send({
    t: 'desk.hello',
    workerCredential,
    client: {
      kind: 'native',
      version: '0.4.0',
      os: 'windows',
      platform: { osVersion: '10.0', arch: 'x64' },
      tokenSource: 'service',
      // `AgentCapabilities` (not the service's own `ServiceCapabilities`): the same features, nothing more.
      capabilities: {
        monitors: 1,
        elevation: 'admin',
        features: [...(opts.features ?? WORKER_FEATURES_BASE)],
        encoders: ['vp8'],
        hwEncoder: false,
        interpreters: ['powershell'],
      },
    },
  });
  return ws;
}

/** The worker's consent that takes an unattended session to `active` (chaining `session.unattended_started`). */
export async function workerConsent(worker: SignalClient): Promise<Msg> {
  worker.send({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1], clipboard: false } });
  return worker.next('consent.ok');
}

/** A device-signed `device.tamper` event (section 10, domain `ia-tamper-v1`). */
export function tamperEvent(d: Dev, cause: string, detail?: string): TamperEvent {
  const base = { id: randomUUID(), cause, at: new Date().toISOString(), ...(detail ? { detail } : {}) };
  return { ...base, sig: signDeviceInput(deviceSigInput.tamper({ deviceId: d.deviceId, event: base }), d.seed) } as TamperEvent;
}

/** A device-signed `device.action_result` frame (rule 9.7, domain `ia-action-v1`). */
export function actionResultFrame(
  d: Dev,
  p: { actionId: string; state: 'awaiting_approval' | 'running' | 'done' | 'failed'; approvedBy?: string; result?: Record<string, unknown> },
): Record<string, unknown> {
  const body = {
    actionId: p.actionId,
    state: p.state,
    ...(p.approvedBy !== undefined ? { approvedBy: p.approvedBy } : {}),
    ...(p.result !== undefined ? { result: p.result } : {}),
  };
  return { t: 'device.action_result', ...body, sig: signDeviceInput(deviceSigInput.action({ deviceId: d.deviceId, ...body }), d.seed) };
}
