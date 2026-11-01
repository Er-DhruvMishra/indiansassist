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
  | 'branding'
  | 'ws.assist'
  | 'recordings'
  | 'playbooks.admin'
  | 'tokens.iaconfig'
  | 'fleet.read'
  | 'fleet.act'
  | 'fleet.amt'
  | 'fleet.queue'
  | 'fleet.admin'
  // Phase E section 2.3
  | 'sso.read'
  | 'sso.admin'
  | 'integrations.read'
  | 'integrations.admin'
  | 'integrations.push'
  | 'ai.admin'
  | 'summary.write'
  | 'summary.read';

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
  branding: ['org_admin'],
  'ws.assist': ['technician', 'senior_technician', 'org_admin'],
  recordings: ['technician', 'senior_technician', 'org_admin', 'auditor'],
  // Phase C 13.4: the playbook catalogue and agent policy page; the signed .iaconfig (also the token creator).
  'playbooks.admin': ['org_admin'],
  'tokens.iaconfig': ['org_admin'],
  // Phase D section 7.1 (the fleet rows of the matrix; "own-group" scoping is the server's, not the client's).
  /** Device list / get. An observer sees the fleet but may take no live action. */
  'fleet.read': ['technician', 'senior_technician', 'org_admin', 'auditor', 'observer'],
  /** Device session open, wake, action run / cancel. */
  'fleet.act': ['technician', 'senior_technician', 'org_admin'],
  /** AMT SOL console and boot redirect (out-of-band access, no on-screen indicator can exist). */
  'fleet.amt': ['senior_technician', 'org_admin'],
  /** The offline action queue list. */
  'fleet.queue': ['technician', 'senior_technician', 'org_admin', 'auditor'],
  /** Groups, policy, group assignment, fleet settings, disable / retire / rotate-key / tamper acknowledge. */
  'fleet.admin': ['org_admin'],
  // Phase E section 2.3 ("own session" scoping of push, summary write and read is the server's, not the client's).
  /** SSO settings read (secrets never shown). */
  'sso.read': ['org_admin', 'auditor'],
  /** SSO configure, domains, SSO required, break-glass, SP key. */
  'sso.admin': ['org_admin'],
  /** Integrations list / read (secrets never shown). */
  'integrations.read': ['org_admin', 'auditor'],
  /** Integrations configure, test, delete, rotate the webhook secret. */
  'integrations.admin': ['org_admin'],
  /** Ticket push and manual retry. */
  'integrations.push': ['technician', 'senior_technician', 'org_admin'],
  /** AI policy change (the policy itself is readable by every role). */
  'ai.admin': ['org_admin'],
  /** Summary generate / regenerate, transcript upload, edit. */
  'summary.write': ['technician', 'senior_technician', 'org_admin'],
  'summary.read': ['technician', 'senior_technician', 'org_admin', 'auditor'],
};

export function can(role: UserRole | null | undefined, cap: Capability): boolean {
  return role ? MATRIX[cap].includes(role) : false;
}

export { roleHasSeat };
