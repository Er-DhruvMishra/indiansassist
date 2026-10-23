/** Client-side view of the permission matrix (contracts section 2.3); the server is authoritative. */
import { roleHasSeat, type UserRole } from '@indiansassist/shared';

export type Capability =
  | 'tokens.create'
  | 'tokens.list'
  | 'sessions.list'
  | 'sessions.end'
  | 'audit.session'
  | 'audit.org'
  | 'audit.export'
  | 'residency'
  | 'users.list'
  | 'users.manage'
  | 'ws.assist'
  | 'recordings';

const MATRIX: Record<Capability, readonly UserRole[]> = {
  'tokens.create': ['technician', 'senior_technician', 'org_admin'],
  'tokens.list': ['technician', 'senior_technician', 'org_admin', 'auditor'],
  'sessions.list': ['technician', 'senior_technician', 'org_admin', 'auditor', 'observer'],
  'sessions.end': ['technician', 'senior_technician', 'org_admin'],
  'audit.session': ['technician', 'senior_technician', 'org_admin', 'auditor'],
  'audit.org': ['senior_technician', 'org_admin', 'auditor'],
  'audit.export': ['org_admin', 'auditor'],
  residency: ['org_admin', 'auditor'],
  'users.list': ['senior_technician', 'org_admin', 'auditor'],
  'users.manage': ['org_admin'],
  'ws.assist': ['technician', 'senior_technician', 'org_admin'],
  recordings: ['technician', 'senior_technician', 'org_admin', 'auditor'],
};

export function can(role: UserRole | null | undefined, cap: Capability): boolean {
  return role ? MATRIX[cap].includes(role) : false;
}

export { roleHasSeat };
