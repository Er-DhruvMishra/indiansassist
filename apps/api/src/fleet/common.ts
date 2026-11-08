/**
 * Phase D shared api helpers (docs/specs/phase-d-contracts.md sections 2.2, 3.6, 8.2c, 13.1a): device presence in the
 * presence store, the device actor, MAC encryption at rest, the effective policy, the `Device` wire object and the
 * `device.policy` push.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import {
  deviceActorLabel,
  openAtRest,
  resolveUnattendedPolicy,
  sealAtRest,
  type Device,
  type InteractiveState,
  type Region,
  type UnattendedPolicy,
  type UnattendedPolicyPatch,
} from '@indiansassist/shared';
import {
  device as deviceTable,
  getDeviceGroupScoped,
  getOrg,
  type DeviceGroupRow,
  type DeviceRow,
  type Executor,
  type OrgRow,
} from '@indiansassist/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Actor } from '../lib/audit.js';
import { isoOrNull } from '../lib/time.js';

// ---------- presence (rule 3.6a) ----------

export type DevicePresence = { connectionId: string; nodeId: string; region: Region };
export const DEVICE_PRESENCE_TTL_SEC = 90;
const devKey = (deviceId: string) => `ia:dev:${deviceId}`;

export async function setDevicePresence(ctx: AppContext, deviceId: string, p: DevicePresence): Promise<void> {
  await ctx.presence.setKey(devKey(deviceId), JSON.stringify(p), DEVICE_PRESENCE_TTL_SEC);
}

export async function getDevicePresence(ctx: AppContext, deviceId: string): Promise<DevicePresence | null> {
  const raw = await ctx.presence.getKey(devKey(deviceId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DevicePresence;
    return typeof v.connectionId === 'string' && typeof v.nodeId === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Clears the entry only when it still names `connectionId` (a newer socket of the device keeps its entry). */
export async function clearDevicePresence(ctx: AppContext, deviceId: string, connectionId: string): Promise<void> {
  const cur = await getDevicePresence(ctx, deviceId);
  if (cur && cur.connectionId === connectionId) await ctx.presence.delKey(devKey(deviceId));
}

export async function isDeviceOnline(ctx: AppContext, deviceId: string): Promise<boolean> {
  const p = await getDevicePresence(ctx, deviceId);
  return p !== null && (p.nodeId === ctx.config.nodeId || (await ctx.presence.isNodeAlive(p.nodeId)));
}

export async function onlineSet(ctx: AppContext, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(ids.map(async (id) => (await isDeviceOnline(ctx, id)) && out.add(id)));
  return out;
}

// ---------- actors ----------

/** The `device` actor of a device-attested entry (Phase D conventions). */
export function deviceActor(deviceId: string): Actor {
  return { type: 'device', id: deviceId, label: deviceActorLabel(deviceId) };
}

// ---------- MAC at rest (rule 8.2c; Phase F section 3.1d rotation) ----------

/** What the MAC helpers need of the context: the fleet keys only (so `pnpm secrets:reseal` can call them). */
export type FleetKeyCtx = { config: { fleet: Pick<AppContext['config']['fleet'], 'dataKey' | 'dataKeyId' | 'previousKeys'> } };

/**
 * Phase F section 3.1d: every key a stored MAC may be opened with, the current one and each of
 * `FLEET_DATA_KEYS_PREVIOUS` (open-only; config refuses a previous entry that repeats the current key id).
 */
export function macKeys(ctx: FleetKeyCtx): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  for (const p of ctx.config.fleet.previousKeys) keys.set(p.keyId, new Uint8Array(p.key));
  keys.set(ctx.config.fleet.dataKeyId, new Uint8Array(ctx.config.fleet.dataKey));
  return keys;
}

const macAad = (deviceId: string) => `ia-mac-v1/${deviceId}`;

/** The key id a sealed MAC names (`<keyId>.<nonce>.<ct>`), or null when it is not of that form. */
function macKeyId(macEnc: string): string | null {
  const parts = macEnc.split('.');
  return parts.length === 3 && parts[0] ? parts[0] : null;
}

/** True when a stored MAC was sealed under a key other than the current fleet key. */
export function macNeedsReseal(ctx: FleetKeyCtx, macEnc: string): boolean {
  return macKeyId(macEnc) !== ctx.config.fleet.dataKeyId;
}

export function encryptMac(ctx: FleetKeyCtx, deviceId: string, mac: string): { macEnc: string; macHash: string } {
  const sub = Buffer.from(hkdfSync('sha256', ctx.config.fleet.dataKey, Buffer.alloc(0), 'ia-mac-hash-v1', 32));
  return {
    macEnc: sealAtRest(new Uint8Array(ctx.config.fleet.dataKey), ctx.config.fleet.dataKeyId, mac, macAad(deviceId)),
    macHash: createHmac('sha256', sub).update(mac).digest('hex'),
  };
}

/** Opens a stored MAC under any known fleet key; null when it does not open (an unknown key, tampering). */
export function openMac(ctx: FleetKeyCtx, deviceId: string, macEnc: string): string | null {
  try {
    return openAtRest(macKeys(ctx), macEnc, macAad(deviceId));
  } catch {
    return null;
  }
}

/**
 * Section 3.1d: re-seals one MAC under the current key and writes `mac_enc` and `mac_hash` (keyed by an HKDF of the
 * fleet key, so it changes too) with a compare-and-set on the old `mac_enc`. False when the row no longer holds
 * `oldEnc` (another request re-sealed or replaced it), which is not an error.
 */
export async function resealDeviceMac(ctx: FleetKeyCtx, exec: Executor, deviceId: string, oldEnc: string, mac: string): Promise<boolean> {
  const next = encryptMac(ctx, deviceId, mac);
  const rows = await exec
    .update(deviceTable)
    .set({ macEnc: next.macEnc, macHash: next.macHash })
    .where(and(eq(deviceTable.id, deviceId), eq(deviceTable.macEnc, oldEnc)))
    .returning({ id: deviceTable.id });
  return rows.length === 1;
}

/** Lazy re-seals still running (`decryptMac` stays synchronous for its callers; tests and shutdown can wait). */
const pendingReseals = new Set<Promise<void>>();

/** Waits for every lazy MAC re-seal started so far. */
export async function settleMacReseals(): Promise<void> {
  while (pendingReseals.size > 0) await Promise.allSettled([...pendingReseals]);
}

/**
 * Opens a stored MAC. Section 3.1d: a MAC that opened under a previous key is re-sealed under the current key in the
 * background (compare-and-set; a failure is logged and the next read tries again). The plaintext is returned either way.
 */
export function decryptMac(ctx: AppContext, deviceId: string, macEnc: string): string | null {
  const mac = openMac(ctx, deviceId, macEnc);
  if (mac !== null && macNeedsReseal(ctx, macEnc)) {
    const p: Promise<void> = resealDeviceMac(ctx, ctx.db, deviceId, macEnc, mac)
      .then(() => undefined)
      .catch((err: unknown) => ctx.log.warn({ err, deviceId }, 'device MAC re-seal failed'))
      .finally(() => pendingReseals.delete(p));
    pendingReseals.add(p);
  }
  return mac;
}

export type MacResealReport = { column: 'device.mac_enc'; scanned: number; resealed: number; lostRace: number; failed: number };

/**
 * Section 3.1e (`pnpm secrets:reseal`): re-seals every `device.mac_enc` not under the current fleet key with the same
 * compare-and-set as the lazy path. A value that does not open is counted as failed and left untouched.
 */
export async function resealAllDeviceMacs(ctx: FleetKeyCtx, exec: Executor): Promise<MacResealReport> {
  const r: MacResealReport = { column: 'device.mac_enc', scanned: 0, resealed: 0, lostRace: 0, failed: 0 };
  const rows = await exec
    .select({ id: deviceTable.id, macEnc: deviceTable.macEnc })
    .from(deviceTable)
    .where(isNotNull(deviceTable.macEnc));
  for (const row of rows) {
    r.scanned++;
    const old = row.macEnc!;
    if (!macNeedsReseal(ctx, old)) continue;
    const mac = openMac(ctx, row.id, old);
    if (mac === null) {
      r.failed++;
      continue;
    }
    if (await resealDeviceMac(ctx, exec, row.id, old, mac)) r.resealed++;
    else r.lostRace++;
  }
  return r;
}

/** The MAC columns to write when the reported `wakeMac` differs from the stored one (null = unchanged). */
export function macPatch(ctx: AppContext, d: Pick<DeviceRow, 'id' | 'macEnc'>, wakeMac: string | null | undefined): { macEnc: string | null; macHash: string | null } | null {
  if (wakeMac === undefined) return null;
  if (wakeMac === null) return d.macEnc === null ? null : { macEnc: null, macHash: null };
  if (d.macEnc && decryptMac(ctx, d.id, d.macEnc) === wakeMac) return null;
  return encryptMac(ctx, d.id, wakeMac);
}

// ---------- policy ----------

export async function groupOf(ctx: AppContext, d: Pick<DeviceRow, 'groupId' | 'orgId'>): Promise<DeviceGroupRow | null> {
  return d.groupId ? getDeviceGroupScoped(ctx.db, d.groupId, d.orgId) : null;
}

/** Section 2.2: `device override ?? group ?? org default`. */
export function effectivePolicy(d: Pick<DeviceRow, 'unattendedPolicy'>, group: Pick<DeviceGroupRow, 'defaultPolicy'> | null, org: Pick<OrgRow, 'unattendedPolicy'>): UnattendedPolicy {
  return resolveUnattendedPolicy({ unattendedPolicy: d.unattendedPolicy }, group ? { defaultPolicy: group.defaultPolicy } : null, org.unattendedPolicy);
}

export async function effectivePolicyFor(ctx: AppContext, d: DeviceRow, org?: OrgRow | null): Promise<UnattendedPolicy> {
  const o = org ?? (await getOrg(ctx.db, d.orgId));
  return effectivePolicy(d, await groupOf(ctx, d), o ?? { unattendedPolicy: {} });
}

/** Rule 9.9: pushes `device.policy` to each listed online device after its effective policy may have changed. */
export async function pushPolicies(ctx: AppContext, devices: readonly DeviceRow[]): Promise<void> {
  const org = devices[0] ? await getOrg(ctx.db, devices[0].orgId) : null;
  for (const d of devices) {
    if (d.status !== 'enrolled') continue;
    try {
      const policy = await effectivePolicyFor(ctx, d, org);
      await ctx.hub.devices.push(d.id, { t: 'device.policy', policy });
    } catch (err) {
      ctx.log.warn({ err, deviceId: d.id }, 'device.policy push failed');
    }
  }
}

// ---------- wire ----------

export function interactiveOf(d: Pick<DeviceRow, 'interactive'>): InteractiveState | null {
  return (d.interactive as InteractiveState | null) ?? null;
}

export function featuresOf(d: Pick<DeviceRow, 'capabilities'>): string[] {
  const f = (d.capabilities as { features?: unknown } | null)?.features;
  return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : [];
}

/** `Device` (section 13.1a); `lastIp` only for org_admin / auditor (residency scope). */
export function toDevice(d: DeviceRow, online: boolean, opts: { withIp?: boolean } = {}): Device {
  const amt = d.amt as Device['amt'];
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    status: d.status,
    // Only an enrolled device can be online: disable / retire / deregister kick its socket, but the presence entry
    // is cleared by the socket's close handler, which can land after the response that changed the status.
    online: online && d.status === 'enrolled',
    keyId: d.keyId ?? null,
    osVersion: d.osVersion ?? null,
    arch: d.arch ?? null,
    agentVersion: d.agentVersion ?? null,
    serviceVersion: d.serviceVersion ?? null,
    groupId: d.groupId ?? null,
    // Section 13.2 `device.unattended_policy`: the stored override as it stands, so the console shows what is set on
    // the device itself rather than inferring it from the effective policy.
    unattendedPolicy: (d.unattendedPolicy as UnattendedPolicyPatch | null) ?? null,
    tags: d.tags,
    capabilities: d.capabilities as Device['capabilities'],
    interactive: interactiveOf(d),
    amt: amt && amt.present ? amt : null,
    tamperState: d.tamperState,
    lanSegmentHash: ((d.lanSegment as { subnetHash?: string } | null)?.subnetHash as string | undefined) ?? null,
    notifyEmail: d.notifyEmail ?? null,
    lastSeenAt: isoOrNull(d.lastSeenAt),
    firstSeenAt: isoOrNull(d.firstSeenAt),
    enrolledAt: isoOrNull(d.enrolledAt),
    lastIp: opts.withIp ? (d.lastIp ?? null) : null,
  };
}
