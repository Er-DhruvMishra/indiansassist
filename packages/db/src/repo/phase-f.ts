/**
 * Phase F repository functions the streams share (docs/specs/phase-f-contracts.md section 13.2a). The names are fixed
 * because another stream reads them; the stream that owns a table may add more beside them. Plain reads and writes
 * only: no chain entries, no mail, no secrets opened.
 */
import { OPEN_ERASURE_STATES, type ErasureState, type ErasureStep } from '@indiansassist/shared';
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  auditEntry,
  orgErasure,
  passwordReset,
  type NewOrgErasureRow,
  type OrgErasureRow,
  type PasswordResetRow,
} from '../schema/index.js';

// ---------- password_reset (mail, section 4.3) ----------

export async function insertPasswordReset(
  exec: Executor,
  values: { userId: string; tokenHash: string; expiresAt: Date },
): Promise<PasswordResetRow> {
  const [row] = await exec.insert(passwordReset).values(values).returning();
  return row!;
}

/** The row of a token hash, whatever its state (the caller applies the 4.3e rules). */
export async function findPasswordResetByHash(exec: Executor, tokenHash: string): Promise<PasswordResetRow | null> {
  const [row] = await exec.select().from(passwordReset).where(eq(passwordReset.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/** Compare-and-set on `used_at is null` and not expired: true for exactly one caller. */
export async function consumePasswordReset(exec: Executor, id: string, now: Date = new Date()): Promise<boolean> {
  const rows = await exec
    .update(passwordReset)
    .set({ usedAt: now })
    .where(and(eq(passwordReset.id, id), isNull(passwordReset.usedAt), gt(passwordReset.expiresAt, now)))
    .returning({ id: passwordReset.id });
  return rows.length === 1;
}

/** Marks every unused token of the user superseded (rule 4.3c); returns how many. */
export async function supersedePasswordResets(exec: Executor, userId: string, now: Date = new Date()): Promise<number> {
  const rows = await exec
    .update(passwordReset)
    .set({ usedAt: now, superseded: true })
    .where(and(eq(passwordReset.userId, userId), isNull(passwordReset.usedAt)))
    .returning({ id: passwordReset.id });
  return rows.length;
}

export async function countPasswordResetsSince(exec: Executor, userId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: count() })
    .from(passwordReset)
    .where(and(eq(passwordReset.userId, userId), gte(passwordReset.createdAt, since)));
  return Number(r?.n ?? 0);
}

/** Deletes rows whose `expires_at` or `used_at` is before `before` (the sweeper passes now - 24 h, rule 4.3h). */
export async function deleteStalePasswordResets(exec: Executor, before: Date): Promise<number> {
  const rows = await exec
    .delete(passwordReset)
    .where(or(lt(passwordReset.expiresAt, before), lt(passwordReset.usedAt, before)))
    .returning({ id: passwordReset.id });
  return rows.length;
}

// ---------- org_erasure (erasure, section 5) ----------

/** The org's open erasure (`pending_confirmation` .. `executing`; at most one by the partial unique index). */
export async function getOpenErasure(exec: Executor, orgId: string): Promise<OrgErasureRow | null> {
  const [row] = await exec
    .select()
    .from(orgErasure)
    .where(and(eq(orgErasure.orgId, orgId), inArray(orgErasure.state, [...OPEN_ERASURE_STATES])))
    .limit(1);
  return row ?? null;
}

export async function getErasure(exec: Executor, id: string): Promise<OrgErasureRow | null> {
  const [row] = await exec.select().from(orgErasure).where(eq(orgErasure.id, id)).limit(1);
  return row ?? null;
}

/** The org's most recent erasure of any state (the erasure page shows the open one, else the latest terminal one). */
export async function getLatestErasure(exec: Executor, orgId: string): Promise<OrgErasureRow | null> {
  const [row] = await exec
    .select()
    .from(orgErasure)
    .where(eq(orgErasure.orgId, orgId))
    .orderBy(desc(orgErasure.requestedAt), desc(orgErasure.createdAt))
    .limit(1);
  return row ?? null;
}

/** Inserts a new attempt; a second open one of the org fails on `org_erasure_open_unique` (`isUniqueViolation`). */
export async function insertErasure(exec: Executor, values: NewOrgErasureRow): Promise<OrgErasureRow> {
  const [row] = await exec.insert(orgErasure).values(values).returning();
  return row!;
}

/** Compare-and-set on `state`: the updated row, or null when the erasure is not in `from` any more. */
export async function transitionErasure(
  exec: Executor,
  id: string,
  from: ErasureState | readonly ErasureState[],
  to: ErasureState,
  patch: Partial<Omit<NewOrgErasureRow, 'id' | 'orgId' | 'state'>> = {},
): Promise<OrgErasureRow | null> {
  const fromList = typeof from === 'string' ? [from] : [...from];
  const [row] = await exec
    .update(orgErasure)
    .set({ ...patch, state: to })
    .where(and(eq(orgErasure.id, id), inArray(orgErasure.state, fromList)))
    .returning();
  return row ?? null;
}

/**
 * Erasures the sweeper must act on at `now`: `cooling_off` whose `cooling_off_until` has passed, and `executing`
 * ones (resumed after a crash, section 5.3). Oldest first. The erasure stream may add its own expiry query beside it.
 */
export async function listDueErasures(exec: Executor, now: Date): Promise<OrgErasureRow[]> {
  return exec
    .select()
    .from(orgErasure)
    .where(
      or(
        and(eq(orgErasure.state, 'cooling_off'), lte(orgErasure.coolingOffUntil, now)),
        eq(orgErasure.state, 'executing'),
      ),
    )
    .orderBy(asc(orgErasure.coolingOffUntil));
}

/** Records a step's completion in `progress` (step name -> ISO time); safe to repeat. */
export async function markErasureStep(exec: Executor, id: string, step: ErasureStep, at: Date = new Date()): Promise<void> {
  await exec
    .update(orgErasure)
    .set({ progress: sql`${orgErasure.progress} || jsonb_build_object(${step}::text, ${at.toISOString()}::text)` })
    .where(eq(orgErasure.id, id));
}

/** One page of the chain digest (section 5.6): `seq`, `hash`, `prevHash` after `afterSeq`, in order. */
export async function listChainDigest(
  exec: Executor,
  orgId: string,
  afterSeq: number,
  limit: number,
): Promise<{ seq: number; hash: string; prevHash: string }[]> {
  return exec
    .select({ seq: auditEntry.seq, hash: auditEntry.hash, prevHash: auditEntry.prevHash })
    .from(auditEntry)
    .where(and(eq(auditEntry.orgId, orgId), gt(auditEntry.seq, afterSeq)))
    .orderBy(asc(auditEntry.seq))
    .limit(limit);
}
