/** Role checks of the section 2.3 permission matrix. */
import type { UserRole } from '@indiansassist/shared';
import { fail } from '../errors.js';

export const TECH_ROLES = ['technician', 'senior_technician', 'org_admin'] as const satisfies readonly UserRole[];
export const ORG_WIDE_ACTORS = ['senior_technician', 'org_admin'] as const satisfies readonly UserRole[];

export function hasRole(role: UserRole, roles: readonly UserRole[]): boolean {
  return roles.includes(role);
}

export function requireRole(role: UserRole, roles: readonly UserRole[]): void {
  if (!hasRole(role, roles)) fail('forbidden', 'your role does not allow this action');
}

/** May accept / deny knocks on (and revoke) any token of the org. */
export function isOrgWideActor(role: UserRole): boolean {
  return hasRole(role, ORG_WIDE_ACTORS);
}

/** "knock accept / deny": own tokens, or any token in the org for senior_technician / org_admin. */
export function canActOnToken(
  user: { id: string; orgId: string; role: UserRole },
  tok: { orgId: string; createdBy: string },
): boolean {
  if (user.orgId !== tok.orgId || !hasRole(user.role, TECH_ROLES)) return false;
  return tok.createdBy === user.id || isOrgWideActor(user.role);
}
