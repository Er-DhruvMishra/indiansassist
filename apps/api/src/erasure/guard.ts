/**
 * Phase F rule 5.2e: while an erasure of the org is `pending_confirmation`, `pending_approval` or `cooling_off`, the
 * admin set is frozen: `routes/users.ts` calls `assertNoOpenErasure` before an invite, a role change and a status
 * change, and it answers `409 erasure_exists` to a change away from `org_admin`, to disabling an org_admin, and to an
 * invite or role change that would create an org_admin. Re-enabling a disabled org_admin is refused too: it would add
 * an active admin (a possible approver) as surely as an invite. Cancelling the erasure lifts the freeze.
 *
 * Section 5.3 step 1 and the coordinator decision on the F0 notes: the sockets that F0 did not gate (the Desk's
 * `desk.hello` and the P4 worker hello) call `refuseIfOrgErasing`, and the sweep passes that must skip an erasing org
 * read `erasingOrgIds`.
 */
import { WS_CLOSE, type UserRole, type UserStatus } from '@indiansassist/shared';
import { getOpenErasure, org as orgTable, type Executor, type OrgRow } from '@indiansassist/db';
import { isNotNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';

/** The user change about to be made (enough to decide whether it touches the org_admin set). */
export type AdminSetChange =
  | { kind: 'invite'; role: UserRole }
  | { kind: 'role'; userId: string; from: UserRole; to: UserRole }
  | { kind: 'status'; userId: string; role: UserRole; from: UserStatus; to: UserStatus };

/** True when the change adds, removes, disables or re-enables an org_admin. */
export function touchesAdminSet(change: AdminSetChange): boolean {
  switch (change.kind) {
    case 'invite':
      return change.role === 'org_admin';
    case 'role':
      return change.from !== change.to && (change.from === 'org_admin' || change.to === 'org_admin');
    case 'status':
      return change.role === 'org_admin' && change.from !== change.to && (change.from === 'active' || change.to === 'active');
  }
}

/** Throws `409 erasure_exists` when the change touches the org_admin set while an erasure is open (rule 5.2e). */
export async function assertNoOpenErasure(
  ctx: AppContext,
  org: Pick<OrgRow, 'id'>,
  change: AdminSetChange,
  exec?: Executor,
): Promise<void> {
  if (!touchesAdminSet(change)) return;
  const open = await getOpenErasure(exec ?? ctx.db, org.id);
  if (open)
    fail('erasure_exists', 'the administrators of this organisation cannot change while its erasure is open; cancel the erasure first', {
      erasureId: open.id,
      state: open.state,
    });
}

/** The ids of every org whose erasure is executing or done (`erasing_at` set): the sweep passes skip them. */
export async function erasingOrgIds(exec: Executor): Promise<Set<string>> {
  const rows = await exec.select({ id: orgTable.id }).from(orgTable).where(isNotNull(orgTable.erasingAt));
  return new Set(rows.map((r) => r.id));
}

type RefusableSocket = {
  error(code: 'org_erasing', message: string, re?: string): void;
  close(code: number, reason?: string): void;
};

/**
 * Section 5.3 step 1: a hello of an org whose erasure is executing answers `error org_erasing` and closes `4403`.
 * Returns true when it refused (the caller returns at once).
 */
export function refuseIfOrgErasing(conn: RefusableSocket, org: Pick<OrgRow, 'erasingAt'> | null | undefined, reId?: string): boolean {
  if (!org || org.erasingAt === null) return false;
  conn.error('org_erasing', 'this organisation is being erased', reId);
  conn.close(WS_CLOSE.forbidden, 'org_erasing');
  return true;
}
