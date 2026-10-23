/** auth_session (cookie sessions, section 6.1) and login_attempt (lockout, section 6.5) repositories. */
import type { Region } from '@indiansassist/shared';
import { and, count, eq, gt, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  authSession,
  loginAttempt,
  user,
  type AuthSessionRow,
  type LoginAttemptRow,
  type UserRow,
} from '../schema/index.js';

export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateAuthSessionInput = {
  userId: string;
  /** sha256Hex of the raw cookie value. */
  tokenHash: string;
  region: Region;
  userAgent?: string | null;
  ip?: string | null;
  /** Defaults to now + 7 days. */
  expiresAt?: Date;
};

export async function createAuthSession(exec: Executor, input: CreateAuthSessionInput): Promise<AuthSessionRow> {
  const [row] = await exec
    .insert(authSession)
    .values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      region: input.region,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      expiresAt: input.expiresAt ?? new Date(Date.now() + AUTH_SESSION_TTL_MS),
    })
    .returning();
  return row!;
}

/** Raw lookup by cookie hash (no validity filter). */
export async function findAuthSession(exec: Executor, tokenHash: string): Promise<AuthSessionRow | null> {
  const [row] = await exec.select().from(authSession).where(eq(authSession.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/** Valid (not revoked, not expired) session plus its user; null otherwise. */
export async function findValidAuthSession(
  exec: Executor,
  tokenHash: string,
  now: Date = new Date(),
): Promise<{ session: AuthSessionRow; user: UserRow } | null> {
  const [row] = await exec
    .select({ session: authSession, user })
    .from(authSession)
    .innerJoin(user, eq(user.id, authSession.userId))
    .where(and(eq(authSession.tokenHash, tokenHash), isNull(authSession.revokedAt), gt(authSession.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** Like findValidAuthSession but by row id (re-validating a long-lived WebSocket principal, section 7.2). */
export async function findValidAuthSessionById(
  exec: Executor,
  id: string,
  now: Date = new Date(),
): Promise<{ session: AuthSessionRow; user: UserRow } | null> {
  const [row] = await exec
    .select({ session: authSession, user })
    .from(authSession)
    .innerJoin(user, eq(user.id, authSession.userId))
    .where(and(eq(authSession.id, id), isNull(authSession.revokedAt), gt(authSession.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** Refreshes last_seen_at at most once per `minIntervalMs` (default one minute). Returns true when written. */
export async function touchAuthSession(exec: Executor, id: string, minIntervalMs = 60_000): Promise<boolean> {
  const rows = await exec
    .update(authSession)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(authSession.id, id),
        lt(authSession.lastSeenAt, sql`now() - ${`${minIntervalMs} milliseconds`}::interval`),
      ),
    )
    .returning({ id: authSession.id });
  return rows.length > 0;
}

export async function revokeAuthSession(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec
    .update(authSession)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(authSession.id, id), isNull(authSession.revokedAt)))
    .returning({ id: authSession.id });
  return rows.length > 0;
}

/** Revokes every live session of a user, optionally keeping one (password change). Returns the count. */
export async function revokeUserAuthSessions(exec: Executor, userId: string, exceptId?: string): Promise<number> {
  const conds = [eq(authSession.userId, userId), isNull(authSession.revokedAt)];
  if (exceptId) conds.push(ne(authSession.id, exceptId));
  const rows = await exec
    .update(authSession)
    .set({ revokedAt: sql`now()` })
    .where(and(...conds))
    .returning({ id: authSession.id });
  return rows.length;
}

export async function deleteAuthSession(exec: Executor, id: string): Promise<boolean> {
  const rows = await exec.delete(authSession).where(eq(authSession.id, id)).returning({ id: authSession.id });
  return rows.length > 0;
}

// ---------- login_attempt ----------

export async function recordLoginAttempt(
  exec: Executor,
  input: { emailHash: string; ip?: string | null; success: boolean; at?: Date },
): Promise<LoginAttemptRow> {
  const [row] = await exec
    .insert(loginAttempt)
    .values({
      emailHash: input.emailHash,
      ip: input.ip ?? null,
      success: input.success,
      ...(input.at ? { at: input.at } : {}),
    })
    .returning();
  return row!;
}

export async function countLoginFailuresSince(exec: Executor, emailHash: string, since: Date): Promise<number> {
  const [row] = await exec
    .select({ n: count() })
    .from(loginAttempt)
    .where(and(eq(loginAttempt.emailHash, emailHash), eq(loginAttempt.success, false), gte(loginAttempt.at, since)));
  return row?.n ?? 0;
}

/** Sweeper: deletes attempts older than `before` (24 h, section 7.6 N4). */
export async function deleteLoginAttemptsBefore(exec: Executor, before: Date): Promise<number> {
  const rows = await exec.delete(loginAttempt).where(lt(loginAttempt.at, before)).returning({ id: loginAttempt.id });
  return rows.length;
}
