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
} from '@indiansassist/shared';
import { getDeviceGroupScoped, getOrg, type DeviceGroupRow, type DeviceRow, type OrgRow } from '@indiansassist/db';
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

// ---------- MAC at rest (rule 8.2c) ----------

function macKeys(ctx: AppContext): Map<string, Uint8Array> {
  return new Map([[ctx.config.fleet.dataKeyId, new Uint8Array(ctx.config.fleet.dataKey)]]);
}

export function encryptMac(ctx: AppContext, deviceId: string, mac: string): { macEnc: string; macHash: string } {
  const sub = Buffer.from(hkdfSync('sha256', ctx.config.fleet.dataKey, Buffer.alloc(0), 'ia-mac-hash-v1', 32));
  return {
    macEnc: sealAtRest(new Uint8Array(ctx.config.fleet.dataKey), ctx.config.fleet.dataKeyId, mac, `ia-mac-v1/${deviceId}`),
    macHash: createHmac('sha256', sub).update(mac).digest('hex'),
  };
}

export function decryptMac(ctx: AppContext, deviceId: string, macEnc: string): string | null {
  try {
    return openAtRest(macKeys(ctx), macEnc, `ia-mac-v1/${deviceId}`);
  } catch {
    return null;
  }
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
    online,
    keyId: d.keyId ?? null,
    osVersion: d.osVersion ?? null,
    arch: d.arch ?? null,
    agentVersion: d.agentVersion ?? null,
    serviceVersion: d.serviceVersion ?? null,
    groupId: d.groupId ?? null,
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
