/**
 * Phase D fleet RBAC (docs/specs/phase-d-contracts.md section 7.1, 7.3): `scopedDevice` is the `scopedSession`
 * analogue (cross-org id -> 404; outside the caller's capability or group scope -> 403). Technician "own-group" scope
 * applies only with `org.fleet_scoping_enabled`: then it is exactly `user.device_group_ids` (null / [] = no devices,
 * ungrouped devices only for senior_technician / org_admin); otherwise the whole org.
 */
import type { UserRole } from '@indiansassist/shared';
import { getDeviceScoped, type DeviceRow, type OrgRow, type UserRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import type { Principal } from '../plugins/auth.js';

/** The section 7.1 capability rows. */
export type FleetCap = 'read' | 'act' | 'amt' | 'queue' | 'admin';

const ROLES: Record<FleetCap, readonly UserRole[]> = {
  read: ['technician', 'senior_technician', 'org_admin', 'auditor', 'observer'],
  act: ['technician', 'senior_technician', 'org_admin'],
  amt: ['senior_technician', 'org_admin'],
  queue: ['technician', 'senior_technician', 'org_admin', 'auditor'],
  admin: ['org_admin'],
};

export function requireFleetRole(p: Principal, cap: FleetCap): void {
  if (!ROLES[cap].includes(p.user.role)) fail('forbidden', 'your role does not allow this fleet action');
}

/** The group ids a technician is limited to, or null for the whole org (section 7.1). */
export function technicianGroups(org: Pick<OrgRow, 'fleetScopingEnabled'>, user: Pick<UserRow, 'role' | 'deviceGroupIds'>): string[] | null {
  if (user.role !== 'technician' || !org.fleetScopingEnabled) return null;
  return user.deviceGroupIds ?? [];
}

export function deviceInScope(org: Pick<OrgRow, 'fleetScopingEnabled'>, user: Pick<UserRow, 'role' | 'deviceGroupIds'>, d: Pick<DeviceRow, 'groupId'>): boolean {
  const groups = technicianGroups(org, user);
  return groups === null || (d.groupId !== null && groups.includes(d.groupId));
}

/** `(id, org_id)` load else 404, then the capability and group check else 403. */
export async function scopedDevice(ctx: AppContext, p: Principal, id: string, cap: FleetCap): Promise<DeviceRow> {
  const d = await getDeviceScoped(ctx.db, id, p.org.id);
  if (!d) fail('not_found', 'device not found');
  requireFleetRole(p, cap);
  if (!deviceInScope(p.org, p.user, d)) fail('forbidden', 'this device is outside your device groups');
  return d;
}
