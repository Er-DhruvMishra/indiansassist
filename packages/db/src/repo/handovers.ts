/**
 * Elevation hand-over log and the session's outstanding hand-over (docs/specs/phase-c-contracts.md section 7.2).
 * The single-use value lives in the presence store (`Presence.consume`); the session row carries its hash, opId and
 * expiry so the sweeper can write `elevation.failed { handover_expired }` after the TTL key has vanished.
 */
import { and, eq, gte, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { elevationHandover, session, type ElevationHandoverRow, type SessionRow } from '../schema/index.js';

export async function insertHandover(
  exec: Executor,
  input: Pick<ElevationHandoverRow, 'sessionId' | 'orgId' | 'tokenHash' | 'opId' | 'expiresAt'>,
): Promise<ElevationHandoverRow> {
  const [row] = await exec.insert(elevationHandover).values(input).returning();
  return row!;
}

/** Settles one unsettled hand-over row (`claimed`, `expired`, `rejected`, `superseded`); false when already settled. */
export async function settleHandover(exec: Executor, tokenHash: string, outcome: 'claimed' | 'expired' | 'rejected' | 'superseded'): Promise<boolean> {
  const rows = await exec
    .update(elevationHandover)
    .set({ outcome, ...(outcome === 'claimed' ? { claimed: true, claimedAt: new Date() } : {}) })
    .where(and(eq(elevationHandover.tokenHash, tokenHash), sql`${elevationHandover.outcome} is null`))
    .returning({ id: elevationHandover.id });
  return rows.length > 0;
}

/** Mints in the session within the window (the 3 per 10 minutes rule). */
export async function countHandoversSince(exec: Executor, sessionId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(elevationHandover)
    .where(and(eq(elevationHandover.sessionId, sessionId), gte(elevationHandover.createdAt, since)));
  return Number(r?.n ?? 0);
}

/** Claimed hand-overs (elevation grants) of an org since `since` (residency report). */
export async function countElevationGrantsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(elevationHandover)
    .where(and(eq(elevationHandover.orgId, orgId), eq(elevationHandover.claimed, true), gte(elevationHandover.createdAt, since)));
  return Number(r?.n ?? 0);
}

/** Non-ended sessions whose outstanding hand-over expired unused (the sweeper's input). */
export async function listExpiredHandoverSessions(exec: Executor, now: Date = new Date()): Promise<SessionRow[]> {
  return exec
    .select()
    .from(session)
    .where(and(isNotNull(session.handoverExpiresAt), lt(session.handoverExpiresAt, now), ne(session.state, 'ended')));
}

/**
 * Clears the outstanding hand-over fields of a session when they still name `hash` (compare-and-clear, so a newer mint
 * is never wiped by a late sweeper). Returns the cleared row or null.
 */
export async function clearSessionHandover(exec: Executor, sessionId: string, hash: string): Promise<SessionRow | null> {
  const rows = await exec
    .update(session)
    .set({ handoverHash: null, handoverOpid: null, handoverExpiresAt: null })
    .where(and(eq(session.id, sessionId), eq(session.handoverHash, hash)))
    .returning();
  return rows[0] ?? null;
}

/** P3 sessions of an org started since `since` (residency report `agentSessions`). */
export async function countAgentSessionsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(session)
    .where(and(eq(session.orgId, orgId), eq(session.tier, 'p3_portable'), gte(session.createdAt, since)));
  return Number(r?.n ?? 0);
}
