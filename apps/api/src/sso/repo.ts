/**
 * Phase E stream sso: the database reads and writes the SSO routes need beyond the shared section 13.2a functions
 * (`getOrgSsoState`, `listVerifiedDomainsByOrg`, `findVerifiedDomain`, `findSsoIdentity`, `insertSsoIdentity`). The
 * sso stream owns `sso_domain`, `sso_identity` and the org / user / auth_session SSO columns, so these live here.
 */
import { and, asc, count, eq, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  authSession,
  org,
  ssoDomain,
  ssoIdentity,
  user,
  type Executor,
  type OrgRow,
  type SsoDomainRow,
  type UserRow,
} from '@indiansassist/db';

// ---------- org SSO columns ----------

export type OrgSsoPatch = Partial<
  Pick<
    OrgRow,
    | 'ssoConfig'
    | 'ssoRequired'
    | 'ssoSecretEnc'
    | 'ssoSecretSetAt'
    | 'ssoSecretFp'
    | 'ssoSpKeyEnc'
    | 'ssoSpKeySetAt'
    | 'ssoSpKeyFp'
    | 'ssoSpCert'
    | 'ssoLastTest'
  >
>;

export async function updateOrgSso(exec: Executor, orgId: string, patch: OrgSsoPatch): Promise<OrgRow> {
  const [row] = await exec
    .update(org)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(org.id, orgId))
    .returning();
  if (!row) throw new Error(`org ${orgId} not found`);
  return row;
}

/** Locks the org row (the SSO-required and break-glass changes serialise on it). */
export async function lockOrg(exec: Executor, orgId: string): Promise<OrgRow | null> {
  const [row] = await exec.select().from(org).where(eq(org.id, orgId)).for('update').limit(1);
  return row ?? null;
}

// ---------- domains ----------

export async function listDomainsByOrg(exec: Executor, orgId: string): Promise<SsoDomainRow[]> {
  return exec.select().from(ssoDomain).where(eq(ssoDomain.orgId, orgId)).orderBy(asc(ssoDomain.createdAt), asc(ssoDomain.domain));
}

export async function countDomainsByOrg(exec: Executor, orgId: string): Promise<number> {
  const [r] = await exec.select({ n: count() }).from(ssoDomain).where(eq(ssoDomain.orgId, orgId));
  return r?.n ?? 0;
}

export async function getDomain(exec: Executor, orgId: string, id: string): Promise<SsoDomainRow | null> {
  const [row] = await exec
    .select()
    .from(ssoDomain)
    .where(and(eq(ssoDomain.orgId, orgId), eq(ssoDomain.id, id)))
    .limit(1);
  return row ?? null;
}

export async function insertDomain(
  exec: Executor,
  input: { orgId: string; domain: string; verifyToken: string; createdBy: string },
): Promise<SsoDomainRow> {
  const [row] = await exec.insert(ssoDomain).values(input).returning();
  return row!;
}

export async function updateDomain(
  exec: Executor,
  id: string,
  patch: Partial<Pick<SsoDomainRow, 'status' | 'verifiedAt' | 'lastCheckedAt' | 'misses'>>,
): Promise<SsoDomainRow> {
  const [row] = await exec.update(ssoDomain).set(patch).where(eq(ssoDomain.id, id)).returning();
  return row!;
}

export async function deleteDomain(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec.delete(ssoDomain).where(eq(ssoDomain.id, id)).returning({ id: ssoDomain.id });
  return rows.length > 0;
}

/** Verified domains whose last check is older than `before` (or never made), oldest first (rule 3.2d). */
export async function listDomainsDueForRecheck(exec: Executor, before: Date, limit: number): Promise<SsoDomainRow[]> {
  return exec
    .select()
    .from(ssoDomain)
    .where(
      and(
        eq(ssoDomain.status, 'verified'),
        or(isNull(ssoDomain.lastCheckedAt), lt(ssoDomain.lastCheckedAt, before)),
      ),
    )
    .orderBy(sql`${ssoDomain.lastCheckedAt} asc nulls first`)
    .limit(limit);
}

// ---------- identities ----------

export async function touchSsoIdentity(exec: Executor, id: string): Promise<void> {
  await exec.update(ssoIdentity).set({ lastLoginAt: new Date() }).where(eq(ssoIdentity.id, id));
}

export async function countIdentitiesByUser(exec: Executor, userId: string): Promise<number> {
  const [r] = await exec.select({ n: count() }).from(ssoIdentity).where(eq(ssoIdentity.userId, userId));
  return r?.n ?? 0;
}

// ---------- users ----------

/** A user of `orgId` whose lower(email) equals `email`, or null. */
export async function findOrgUserByEmail(exec: Executor, orgId: string, email: string): Promise<UserRow | null> {
  const [row] = await exec
    .select()
    .from(user)
    .where(and(eq(user.orgId, orgId), sql`lower(${user.email}) = ${email.trim().toLowerCase()}`))
    .limit(1);
  return row ?? null;
}

export async function getOrgUsers(exec: Executor, orgId: string, ids: string[]): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return exec
    .select()
    .from(user)
    .where(and(eq(user.orgId, orgId), inArray(user.id, ids)));
}

/** Sets `sso_break_glass` on exactly `ids` within the org (clears it everywhere else). */
export async function setBreakGlassUsers(exec: Executor, orgId: string, ids: string[]): Promise<void> {
  await exec
    .update(user)
    .set({ ssoBreakGlass: false, updatedAt: new Date() })
    .where(
      and(eq(user.orgId, orgId), eq(user.ssoBreakGlass, true), ...(ids.length > 0 ? [notInArray(user.id, ids)] : [])),
    );
  if (ids.length > 0)
    await exec
      .update(user)
      .set({ ssoBreakGlass: true, updatedAt: new Date() })
      .where(and(eq(user.orgId, orgId), inArray(user.id, ids)));
}

export async function clearBreakGlass(exec: Executor, userId: string): Promise<void> {
  await exec.update(user).set({ ssoBreakGlass: false, updatedAt: new Date() }).where(eq(user.id, userId));
}

/** Break-glass users of the org that could sign in now (active org_admins), optionally excluding one. */
export async function countUsableBreakGlass(exec: Executor, orgId: string, exceptUserId?: string): Promise<number> {
  const conds = [eq(user.orgId, orgId), eq(user.ssoBreakGlass, true), eq(user.status, 'active'), eq(user.role, 'org_admin')];
  if (exceptUserId) conds.push(ne(user.id, exceptUserId));
  const [r] = await exec.select({ n: count() }).from(user).where(and(...conds));
  return r?.n ?? 0;
}

export async function listBreakGlassUsers(exec: Executor, orgId: string): Promise<UserRow[]> {
  return exec
    .select()
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.ssoBreakGlass, true)))
    .orderBy(asc(user.createdAt));
}

/** Active org_admins of the org other than `exceptUserId` (the break-glass notice recipients, rule 3.7d). */
export async function listOtherActiveAdmins(exec: Executor, orgId: string, exceptUserId: string): Promise<UserRow[]> {
  return exec
    .select()
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.role, 'org_admin'), eq(user.status, 'active'), ne(user.id, exceptUserId)));
}

/**
 * Rule 3.7a warning: active users of the org whose email domain is not one of `verifiedDomains` and who have no
 * `sso_identity`; they could not sign in once SSO is required.
 */
export async function countUsersOutsideDomains(exec: Executor, orgId: string, verifiedDomains: string[]): Promise<number> {
  const domainExpr = sql`lower(split_part(${user.email}, '@', 2))`;
  const conds = [
    eq(user.orgId, orgId),
    eq(user.status, 'active'),
    sql`not exists (select 1 from ${ssoIdentity} where ${ssoIdentity.userId} = ${user.id})`,
  ];
  if (verifiedDomains.length > 0) conds.push(sql`${domainExpr} not in (${sql.join(verifiedDomains.map((d) => sql`${d}`), sql`, `)})`);
  const [r] = await exec.select({ n: count() }).from(user).where(and(...conds));
  return r?.n ?? 0;
}

// ---------- sessions (rule 3.7c) ----------

/**
 * Revokes every live session of the org whose login method is `local`, `invite` or null and whose user is not
 * break-glass; returns the revoked ids (for closing their sockets).
 */
export async function revokePasswordSessionsForSso(exec: Executor, orgId: string): Promise<string[]> {
  const rows = await exec
    .update(authSession)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        isNull(authSession.revokedAt),
        sql`${authSession.expiresAt} > now()`,
        or(isNull(authSession.loginMethod), inArray(authSession.loginMethod, ['local', 'invite'])),
        sql`${authSession.userId} in (select ${user.id} from ${user} where ${user.orgId} = ${orgId} and ${user.ssoBreakGlass} = false)`,
      ),
    )
    .returning({ id: authSession.id });
  return rows.map((r) => r.id);
}

/** Cuts every live session of the org's break-glass users to at most `hours` from now (rule 3.7c). */
export async function capBreakGlassSessions(exec: Executor, orgId: string, hours: number): Promise<number> {
  const rows = await exec
    .update(authSession)
    .set({ expiresAt: sql`least(${authSession.expiresAt}, now() + ${`${hours} hours`}::interval)` })
    .where(
      and(
        isNull(authSession.revokedAt),
        sql`${authSession.expiresAt} > now()`,
        sql`${authSession.userId} in (select ${user.id} from ${user} where ${user.orgId} = ${orgId} and ${user.ssoBreakGlass} = true)`,
      ),
    )
    .returning({ id: authSession.id });
  return rows.length;
}
