/** Thin wrappers over the db audit writer: actors of section 5.3 and the ia_audit_entries_total counter. */
import { deskActorLabel, pepperedHash, type ActorType } from '@indiansassist/shared';
import { insertAuditEntry, OrgErasedError, type AuditEntryRow, type AuditInput, type Executor, type OrgRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';

export type Actor = { type: ActorType; id: string | null; label: string };

export const systemActor: Actor = { type: 'system', id: null, label: 'system' };

export function userActor(u: { id: string; name: string }): Actor {
  return { type: 'user', id: u.id, label: u.name };
}

export function deskActor(deskRef: string): Actor {
  return { type: 'desk', id: deskRef, label: deskActorLabel(deskRef) };
}

/** Appends one entry (inside the caller's transaction when `exec` is a Tx). */
export async function writeAudit(
  ctx: Pick<AppContext, 'metrics'>,
  exec: Executor,
  org: Pick<OrgRow, 'id' | 'dataRegion'>,
  input: Omit<AuditInput, 'orgId' | 'region'>,
): Promise<AuditEntryRow> {
  const row = await insertAuditEntry(exec, { ...input, orgId: org.id, region: org.dataRegion });
  ctx.metrics.auditEntries.inc();
  return row;
}

/**
 * PII rule of section 5.3: `sha256Hex(org.audit_pepper + ':' + value)`. Phase F section 5.3 step 6: an erased org's
 * pepper is null, and hashing would yield an unpeppered (linkable) value, so it throws `OrgErasedError` instead.
 */
export function piiHash(org: Pick<OrgRow, 'auditPepper'> & { id?: string }, value: string): string {
  if (org.auditPepper === null) throw new OrgErasedError(org.id ?? 'unknown');
  return pepperedHash(org.auditPepper, value);
}
