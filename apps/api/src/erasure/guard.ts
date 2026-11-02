/**
 * Phase F rule 5.2e: while an erasure of the org is `pending_confirmation`, `pending_approval` or `cooling_off`, the
 * admin set is frozen: `routes/users.ts` calls `assertNoOpenErasure` before an invite, a role change and a status
 * change, and it answers `409 erasure_exists` to a change away from `org_admin`, to disabling an org_admin, and to an
 * invite or role change that would create an org_admin. The foundation lands the call sites and this stub, which
 * allows every change; the erasure stream fills the body without editing `routes/users.ts`.
 */
import type { UserRole, UserStatus } from '@indiansassist/shared';
import type { Executor, OrgRow } from '@indiansassist/db';
import type { AppContext } from '../context.js';

/** The user change about to be made (enough to decide whether it touches the org_admin set). */
export type AdminSetChange =
  | { kind: 'invite'; role: UserRole }
  | { kind: 'role'; userId: string; from: UserRole; to: UserRole }
  | { kind: 'status'; userId: string; role: UserRole; from: UserStatus; to: UserStatus };

/** Throws `409 erasure_exists` when the change touches the org_admin set while an erasure is open (erasure stream). */
export async function assertNoOpenErasure(
  ctx: AppContext,
  org: Pick<OrgRow, 'id'>,
  change: AdminSetChange,
  exec?: Executor,
): Promise<void> {
  void ctx;
  void org;
  void change;
  void exec;
}
