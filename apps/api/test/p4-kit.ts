/**
 * Phase D test helpers (docs/specs/phase-d-contracts.md sections 3.2, 3.4, 7.2): a P4-plan app and org_admin, a
 * simulated installed service holding its own identity and sealing keys, enrollment with the possession proof of
 * rule 3.2, and a signed `/signal/device` hello. Shared by `p4.test.ts`, `amt.test.ts` and `vault.test.ts` so the
 * enrollment shape lives in one place.
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
  type AmtInventory,
} from '@indiansassist/shared';
import { expect } from 'vitest';
import { call, createToken, makeApp, signup, SignalClient, type Account, type TestApp } from './helpers.js';

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
export function makeP4App(env: Record<string, string> = {}): Promise<TestApp> {
  return makeApp({ SIGNUP_PLAN_TIER: 'p4_installed', ...env });
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
  opts: { interactive?: string; badSig?: boolean; amt?: AmtInventory | null; subnetHash?: string; track?: SignalClient[] } = {},
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
      wakeMac: null,
      amt: opts.amt ?? null,
      interactive: { state: opts.interactive ?? 'locked', idleSec: null, at: Date.now() },
    },
  });
  return ws;
}
