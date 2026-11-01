/**
 * Device and device-group repositories (docs/specs/phase-d-contracts.md sections 2.2, 3, 7, 13.2). Every load that
 * answers a REST call is scoped by `(id, org_id)` so another org's id reads as absent (`404`). Device rows are mutable
 * (facts, last-seen, tamper state); the chain records the privileged events, not the row mutations.
 */
import type { DeviceStatus, TamperState } from '@indiansassist/shared';
import { and, asc, desc, eq, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { DbError, isUniqueViolation } from '../errors.js';
import { device, deviceGroup, session, token, type DeviceGroupRow, type DeviceRow, type NewDeviceRow, type SessionRow, type TokenRow } from '../schema/index.js';
import { clampLimit, InvalidCursorError, msTrunc, toPage, type Page, type PageQuery } from './page.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Statuses that may still `device.hello` (rule 3.7c). */
export const DEVICE_LIVE_STATUSES = ['enrolled'] as const satisfies readonly DeviceStatus[];

// ---------- devices ----------

export async function insertDevice(exec: Executor, input: NewDeviceRow): Promise<DeviceRow> {
  const [row] = await exec.insert(device).values(input).returning();
  return row!;
}

export async function getDevice(exec: Executor, id: string): Promise<DeviceRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec.select().from(device).where(eq(device.id, id)).limit(1);
  return row ?? null;
}

/** The device `id` of org `orgId`, or null. */
export async function getDeviceScoped(exec: Executor, id: string, orgId: string): Promise<DeviceRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec
    .select()
    .from(device)
    .where(and(eq(device.id, id), eq(device.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function lockDevice(exec: Executor, id: string): Promise<DeviceRow | null> {
  const [row] = await exec.select().from(device).where(eq(device.id, id)).limit(1).for('update');
  return row ?? null;
}

export type DevicePatchInput = Partial<
  Pick<
    DeviceRow,
    | 'name'
    | 'status'
    | 'tags'
    | 'capabilities'
    | 'lastSeenAt'
    | 'publicKey'
    | 'keyId'
    | 'kexPublicKey'
    | 'osVersion'
    | 'agentVersion'
    | 'serviceVersion'
    | 'arch'
    | 'lastIp'
    | 'groupId'
    | 'unattendedPolicy'
    | 'interactive'
    | 'lanSegment'
    | 'macEnc'
    | 'macHash'
    | 'amt'
    | 'tamperState'
    | 'notifyEmail'
    | 'rotationNonce'
    | 'firstSeenAt'
  >
>;

export async function updateDevice(exec: Executor, id: string, patch: DevicePatchInput): Promise<DeviceRow | null> {
  if (Object.keys(patch).length === 0) return getDevice(exec, id);
  const [row] = await exec.update(device).set(patch).where(eq(device.id, id)).returning();
  return row ?? null;
}

/** Conditional status change (`from` -> `to`); null when the row was not in `from`. */
export async function setDeviceStatus(
  exec: Executor,
  id: string,
  to: DeviceStatus,
  from: readonly DeviceStatus[],
  extra: DevicePatchInput = {},
): Promise<DeviceRow | null> {
  const [row] = await exec
    .update(device)
    .set({ ...extra, status: to })
    .where(and(eq(device.id, id), inArray(device.status, [...from])))
    .returning();
  return row ?? null;
}

/** Rule 3.7a: an `enrolled` device of the org with the same machine fingerprint. */
export async function findEnrolledByFingerprint(exec: Executor, orgId: string, hwFingerprint: string): Promise<DeviceRow | null> {
  const [row] = await exec
    .select()
    .from(device)
    .where(and(eq(device.orgId, orgId), eq(device.hwFingerprint, hwFingerprint), eq(device.status, 'enrolled')))
    .orderBy(desc(device.createdAt))
    .limit(1);
  return row ?? null;
}

export type ListDevicesQuery = PageQuery & {
  groupId?: string | 'none';
  /** Scope to these groups (fleet scoping, section 7.1); `[]` matches nothing. */
  groupIds?: readonly string[];
  tag?: string;
  status?: DeviceStatus;
  q?: string;
  /** Restrict to these ids (the `online` filter is folded by the caller from presence). */
  ids?: readonly string[];
  excludeIds?: readonly string[];
};

/** Cursor `<lastSeenAt ISO | ''>|<id>` (section 7.2), newest-seen first, never-seen last. */
export function encodeDeviceCursor(row: Pick<DeviceRow, 'lastSeenAt' | 'id'>): string {
  return `${row.lastSeenAt ? row.lastSeenAt.toISOString() : ''}|${row.id}`;
}

function decodeDeviceCursor(c: string): { lastSeenAt: string | null; id: string } {
  const i = c.lastIndexOf('|');
  if (i < 0) throw new InvalidCursorError();
  const ts = c.slice(0, i);
  const id = c.slice(i + 1);
  if (!UUID_RE.test(id) || (ts !== '' && Number.isNaN(Date.parse(ts)))) throw new InvalidCursorError();
  return { lastSeenAt: ts === '' ? null : ts, id };
}

/** Devices of an org (section 7.2), `last_seen_at desc nulls last, id desc`. */
export async function listDevicesByOrg(exec: Executor, orgId: string, q: ListDevicesQuery = {}): Promise<Page<DeviceRow>> {
  const limit = clampLimit(q.limit);
  const conds: SQL[] = [eq(device.orgId, orgId)];
  if (q.groupId === 'none') conds.push(isNull(device.groupId));
  else if (q.groupId) conds.push(eq(device.groupId, q.groupId));
  if (q.groupIds !== undefined) {
    if (q.groupIds.length === 0) return { items: [], nextCursor: null };
    conds.push(inArray(device.groupId, [...q.groupIds]));
  }
  if (q.tag) conds.push(sql`${q.tag} = any(${device.tags})`);
  if (q.status) conds.push(eq(device.status, q.status));
  if (q.q) conds.push(ilike(device.name, `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
  if (q.ids !== undefined) {
    if (q.ids.length === 0) return { items: [], nextCursor: null };
    conds.push(inArray(device.id, [...q.ids]));
  }
  if (q.excludeIds && q.excludeIds.length > 0) conds.push(notInArray(device.id, [...q.excludeIds]));
  const seen = msTrunc(device.lastSeenAt);
  if (q.cursor) {
    const c = decodeDeviceCursor(q.cursor);
    conds.push(
      c.lastSeenAt === null
        ? sql`(${device.lastSeenAt} is null and ${device.id} < ${c.id}::uuid)`
        : or(sql`${device.lastSeenAt} is null`, sql`(${seen}, ${device.id}) < (${c.lastSeenAt}::timestamptz, ${c.id}::uuid)`)!,
    );
  }
  const rows = await exec
    .select()
    .from(device)
    .where(and(...conds))
    .orderBy(sql`${seen} desc nulls last`, desc(device.id))
    .limit(limit + 1);
  return toPage(rows, limit, encodeDeviceCursor);
}

/** Every live (`enrolled`) device of an org in a LAN segment (rule 8.2b election input). */
export async function listDevicesInSegment(exec: Executor, orgId: string, subnetHash: string): Promise<DeviceRow[]> {
  return exec
    .select()
    .from(device)
    .where(and(eq(device.orgId, orgId), eq(device.status, 'enrolled'), sql`${device.lanSegment}->>'subnetHash' = ${subnetHash}`));
}

/** Devices whose effective policy may change with a group / org policy change (`device.policy` pushes). */
export async function listDevicesByGroup(exec: Executor, orgId: string, groupId: string | null): Promise<DeviceRow[]> {
  return exec
    .select()
    .from(device)
    .where(and(eq(device.orgId, orgId), groupId === null ? isNull(device.groupId) : eq(device.groupId, groupId), eq(device.status, 'enrolled')));
}

export async function listEnrolledDevices(exec: Executor, orgId?: string): Promise<DeviceRow[]> {
  return exec
    .select()
    .from(device)
    .where(orgId ? and(eq(device.orgId, orgId), eq(device.status, 'enrolled')) : eq(device.status, 'enrolled'));
}

export async function countDevices(exec: Executor, orgId: string, opts: { excludeRetired?: boolean } = {}): Promise<number> {
  const conds: SQL[] = [eq(device.orgId, orgId)];
  if (opts.excludeRetired) conds.push(ne(device.status, 'retired'));
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(device)
    .where(and(...conds));
  return Number(r?.n ?? 0);
}

/** Rule 8.4c: devices whose AMT is provisioned over plain HTTP (residency report). */
export async function countAmtPlainHttpDevices(exec: Executor, orgId: string): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(device)
    .where(and(eq(device.orgId, orgId), sql`(${device.amt}->>'present')::boolean is true`, sql`(${device.amt}->>'tls')::boolean is false`));
  return Number(r?.n ?? 0);
}

/** Rule 3.5a: the one non-ended session of a device. */
export async function findOpenSessionByDevice(exec: Executor, deviceId: string): Promise<SessionRow | null> {
  const [row] = await exec
    .select()
    .from(session)
    .where(and(eq(session.deviceId, deviceId), ne(session.state, 'ended')))
    .limit(1);
  return row ?? null;
}

export async function listRecentSessionsByDevice(exec: Executor, deviceId: string, limit = 10): Promise<SessionRow[]> {
  return exec.select().from(session).where(eq(session.deviceId, deviceId)).orderBy(desc(session.createdAt)).limit(limit);
}

/** Unattended P4 sessions of an org started since `since` (residency report). */
export async function countUnattendedSessionsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(session)
    .where(and(eq(session.orgId, orgId), eq(session.unattended, true), sql`${session.createdAt} >= ${since.toISOString()}::timestamptz`));
  return Number(r?.n ?? 0);
}

// ---------- enrollment tokens ----------

/**
 * Section 3.2: counts one enrollment against a token row the caller has locked (`lockToken`); the token goes `used`
 * when the count reaches `max_devices`. Null when the token has no capacity left.
 */
export async function countEnrollment(exec: Executor, tok: TokenRow, at: Date = new Date()): Promise<TokenRow | null> {
  if (tok.devicesEnrolled >= tok.maxDevices) return null;
  const reached = tok.devicesEnrolled + 1 >= tok.maxDevices;
  const [row] = await exec
    .update(token)
    .set({ devicesEnrolled: sql`${token.devicesEnrolled} + 1`, ...(reached ? { status: 'used' as const, usedAt: at } : {}) })
    .where(and(eq(token.id, tok.id), sql`${token.devicesEnrolled} < ${token.maxDevices}`))
    .returning();
  return row ?? null;
}

// ---------- device groups ----------

/** `(org_id, name)` is taken. */
export class DeviceGroupNameTakenError extends DbError {
  constructor() {
    super('device_group_name_taken', 'a device group with this name exists');
  }
}

async function groupNameSafe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err, 'device_group_org_name_unique')) throw new DeviceGroupNameTakenError();
    throw err;
  }
}

export type DeviceGroupInput = {
  orgId: string;
  name: string;
  description?: string | null;
  defaultPolicy?: Record<string, unknown>;
  defaultTags?: string[];
  notifyEmail?: string | null;
  createdBy: string;
};

export async function insertDeviceGroup(exec: Executor, input: DeviceGroupInput): Promise<DeviceGroupRow> {
  return groupNameSafe(async () => {
    const [row] = await exec.transaction(async (tx) => tx.insert(deviceGroup).values(input).returning());
    return row!;
  });
}

export async function getDeviceGroupScoped(exec: Executor, id: string, orgId: string): Promise<DeviceGroupRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec
    .select()
    .from(deviceGroup)
    .where(and(eq(deviceGroup.id, id), eq(deviceGroup.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

export async function listDeviceGroups(exec: Executor, orgId: string): Promise<DeviceGroupRow[]> {
  return exec.select().from(deviceGroup).where(eq(deviceGroup.orgId, orgId)).orderBy(asc(deviceGroup.name));
}

export async function countDeviceGroups(exec: Executor, orgId: string): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceGroup)
    .where(eq(deviceGroup.orgId, orgId));
  return Number(r?.n ?? 0);
}

export type DeviceGroupPatchInput = Partial<Pick<DeviceGroupRow, 'name' | 'description' | 'defaultPolicy' | 'defaultTags' | 'notifyEmail'>>;

export async function updateDeviceGroup(exec: Executor, id: string, orgId: string, patch: DeviceGroupPatchInput): Promise<DeviceGroupRow | null> {
  return groupNameSafe(async () => {
    const rows = await exec.transaction(async (tx) =>
      tx
        .update(deviceGroup)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(deviceGroup.id, id), eq(deviceGroup.orgId, orgId)))
        .returning(),
    );
    return rows[0] ?? null;
  });
}

/** Deletes a group; its devices fall back to the org default policy (`group_id := null`). */
export async function deleteDeviceGroup(exec: Executor, id: string, orgId: string): Promise<boolean> {
  return exec.transaction(async (tx) => {
    await tx
      .update(device)
      .set({ groupId: null })
      .where(and(eq(device.orgId, orgId), eq(device.groupId, id)));
    const rows = await tx
      .delete(deviceGroup)
      .where(and(eq(deviceGroup.id, id), eq(deviceGroup.orgId, orgId)))
      .returning({ id: deviceGroup.id });
    return rows.length > 0;
  });
}

export type { TamperState };
