/** user and technician_seat repositories (contracts sections 2.4, 4.2, 6.6). */
import type { PackageTier, UserRole, UserStatus } from '@indiansassist/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { NotFoundError } from '../errors.js';
import { technicianSeat, user, type TechnicianSeatRow, type UserRow } from '../schema/index.js';
import { clampLimit, timeIdAfter, timeIdCursorOf, timeIdOrder, toPage, type Page, type PageQuery } from './page.js';

export type CreateUserInput = {
  orgId: string;
  email: string;
  name: string;
  role: UserRole;
  status?: UserStatus;
  passwordHash?: string | null;
  authProvider?: string;
  authRef?: string | null;
  inviteTokenHash?: string | null;
  inviteExpiresAt?: Date | null;
  /** Phase F section 5.2b: the inviting admin (null for the signup admin and JIT users). */
  roleGrantedBy?: string | null;
};

export type UserPatch = Partial<
  Pick<
    UserRow,
    | 'name'
    | 'role'
    | 'status'
    | 'passwordHash'
    | 'authRef'
    | 'inviteTokenHash'
    | 'inviteExpiresAt'
    | 'lastLoginAt'
    | 'deviceGroupIds'
    // Phase F sections 4.2c, 5.2b.
    | 'inviteMailedAt'
    | 'roleSince'
    | 'roleGrantedBy'
  >
>;

export type UserWithSeat = UserRow & { seat: TechnicianSeatRow | null };

export async function createUser(exec: Executor, input: CreateUserInput): Promise<UserRow> {
  const [row] = await exec
    .insert(user)
    .values({
      orgId: input.orgId,
      email: input.email.trim(),
      name: input.name,
      role: input.role,
      status: input.status ?? 'active',
      passwordHash: input.passwordHash ?? null,
      authProvider: input.authProvider ?? 'local',
      authRef: input.authRef ?? null,
      inviteTokenHash: input.inviteTokenHash ?? null,
      inviteExpiresAt: input.inviteExpiresAt ?? null,
      roleGrantedBy: input.roleGrantedBy ?? null,
    })
    .returning();
  return row!;
}

export async function getUser(exec: Executor, id: string): Promise<UserRow | null> {
  const [row] = await exec.select().from(user).where(eq(user.id, id)).limit(1);
  return row ?? null;
}

/** Case-insensitive lookup (unique index on lower(email)). */
export async function findUserByEmail(exec: Executor, email: string): Promise<UserRow | null> {
  const [row] = await exec
    .select()
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email.trim()})`)
    .limit(1);
  return row ?? null;
}

export async function findUserByInviteHash(exec: Executor, inviteTokenHash: string): Promise<UserRow | null> {
  const [row] = await exec.select().from(user).where(eq(user.inviteTokenHash, inviteTokenHash)).limit(1);
  return row ?? null;
}

/** Users of an org with their seat, ordered `created_at asc, id asc` (section 6.6). */
export async function listUsersByOrg(exec: Executor, orgId: string, q: PageQuery = {}): Promise<Page<UserWithSeat>> {
  const limit = clampLimit(q.limit);
  const after = timeIdAfter(user.createdAt, user.id, q.cursor, 'asc');
  const rows = await exec
    .select({ user, seat: technicianSeat })
    .from(user)
    .leftJoin(technicianSeat, eq(technicianSeat.userId, user.id))
    .where(after ? and(eq(user.orgId, orgId), after) : eq(user.orgId, orgId))
    .orderBy(...timeIdOrder(user.createdAt, user.id, 'asc'))
    .limit(limit + 1);
  const items = rows.map((r) => ({ ...r.user, seat: r.seat }));
  return toPage(items, limit, timeIdCursorOf);
}

export async function updateUser(exec: Executor, id: string, patch: UserPatch): Promise<UserRow> {
  const [row] = await exec.update(user).set(patch).where(eq(user.id, id)).returning();
  if (!row) throw new NotFoundError('user', id);
  return row;
}

/** Number of org_admin users with the given status (default `active`), for the `last_org_admin` rule. */
export async function countOrgAdmins(exec: Executor, orgId: string, status: UserStatus = 'active'): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.role, 'org_admin'), eq(user.status, status)));
  return row?.n ?? 0;
}

// ---------- technician_seat ----------

export async function createSeat(
  exec: Executor,
  input: { orgId: string; userId: string; tier?: PackageTier; active?: boolean },
): Promise<TechnicianSeatRow> {
  const [row] = await exec
    .insert(technicianSeat)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      tier: input.tier ?? 'p1_browser',
      active: input.active ?? true,
    })
    .returning();
  return row!;
}

export async function getSeatByUser(exec: Executor, userId: string): Promise<TechnicianSeatRow | null> {
  const [row] = await exec.select().from(technicianSeat).where(eq(technicianSeat.userId, userId)).limit(1);
  return row ?? null;
}

export async function updateSeat(
  exec: Executor,
  userId: string,
  patch: { tier?: PackageTier; active?: boolean },
): Promise<TechnicianSeatRow> {
  const [row] = await exec.update(technicianSeat).set(patch).where(eq(technicianSeat.userId, userId)).returning();
  if (!row) throw new NotFoundError('technician_seat for user', userId);
  return row;
}

export async function deleteSeatByUser(exec: Executor, userId: string): Promise<boolean> {
  const rows = await exec
    .delete(technicianSeat)
    .where(eq(technicianSeat.userId, userId))
    .returning({ id: technicianSeat.id });
  return rows.length > 0;
}

export async function listSeatsByOrg(exec: Executor, orgId: string): Promise<TechnicianSeatRow[]> {
  return exec.select().from(technicianSeat).where(eq(technicianSeat.orgId, orgId)).orderBy(technicianSeat.createdAt);
}

export async function countSeats(exec: Executor, orgId: string, opts: { activeOnly?: boolean } = {}): Promise<number> {
  const where = opts.activeOnly
    ? and(eq(technicianSeat.orgId, orgId), eq(technicianSeat.active, true))
    : eq(technicianSeat.orgId, orgId);
  const [row] = await exec.select({ n: count() }).from(technicianSeat).where(where);
  return row?.n ?? 0;
}
