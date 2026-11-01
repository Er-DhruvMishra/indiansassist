/**
 * Device action queue, wake attempts and AMT SOL sessions (docs/specs/phase-d-contracts.md sections 8, 9, 13.2).
 * State changes are conditional `UPDATE ... WHERE state IN (...)` so two nodes cannot both win the same edge.
 */
import { LIMITS, type DeviceActionState, type WakeState } from '@indiansassist/shared';
import { and, asc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  amtSol,
  deviceAction,
  wakeAttempt,
  type AmtSolRow,
  type DeviceActionRow,
  type NewDeviceActionRow,
  type WakeAttemptRow,
} from '../schema/index.js';
import { clampLimit, timeIdAfter, timeIdCursorOf, timeIdOrder, toPage, type Page, type PageQuery } from './page.js';
import { UUID_RE } from './devices.js';

// ---------- device actions (rule 9.2) ----------

export async function insertDeviceAction(exec: Executor, input: Omit<NewDeviceActionRow, 'expiresAt'> & { expiresAt?: Date }): Promise<DeviceActionRow> {
  const [row] = await exec
    .insert(deviceAction)
    .values({ ...input, expiresAt: input.expiresAt ?? new Date(Date.now() + LIMITS.deviceActionTtlDays * 86_400_000) })
    .returning();
  return row!;
}

export async function getDeviceAction(exec: Executor, id: string): Promise<DeviceActionRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec.select().from(deviceAction).where(eq(deviceAction.id, id)).limit(1);
  return row ?? null;
}

/** Actions of a device, newest first. */
export async function listDeviceActions(
  exec: Executor,
  deviceId: string,
  q: PageQuery & { state?: DeviceActionState } = {},
): Promise<Page<DeviceActionRow>> {
  const limit = clampLimit(q.limit);
  const conds: SQL[] = [eq(deviceAction.deviceId, deviceId)];
  if (q.state) conds.push(eq(deviceAction.state, q.state));
  const after = timeIdAfter(deviceAction.createdAt, deviceAction.id, q.cursor, 'desc');
  if (after) conds.push(after);
  const rows = await exec
    .select()
    .from(deviceAction)
    .where(and(...conds))
    .orderBy(...timeIdOrder(deviceAction.createdAt, deviceAction.id, 'desc'))
    .limit(limit + 1);
  return toPage(rows, limit, timeIdCursorOf);
}

/** The queue a device drains on check-in (oldest first, unexpired, `queued`). */
export async function listQueuedActions(exec: Executor, deviceId: string, max: number = LIMITS.deviceQueueDrainMax, now: Date = new Date()): Promise<DeviceActionRow[]> {
  return exec
    .select()
    .from(deviceAction)
    .where(and(eq(deviceAction.deviceId, deviceId), eq(deviceAction.state, 'queued'), gte(deviceAction.expiresAt, now)))
    .orderBy(asc(deviceAction.createdAt), asc(deviceAction.id))
    .limit(max);
}

export type DeviceActionUpdate = Partial<Pick<DeviceActionRow, 'approvedBy' | 'result' | 'dispatchedAt' | 'completedAt'>>;

/** Moves an action to `to` when it is in one of `from`; null when it was not (a lost race or a final state). */
export async function transitionDeviceAction(
  exec: Executor,
  id: string,
  to: DeviceActionState,
  from: readonly DeviceActionState[],
  set: DeviceActionUpdate = {},
): Promise<DeviceActionRow | null> {
  const [row] = await exec
    .update(deviceAction)
    .set({ ...set, state: to, updatedAt: new Date() })
    .where(and(eq(deviceAction.id, id), inArray(deviceAction.state, [...from])))
    .returning();
  return row ?? null;
}

/** Sweeper: non-final actions past `expires_at` go `expired`; returns the rows changed. */
export async function expireDeviceActions(exec: Executor, now: Date = new Date()): Promise<DeviceActionRow[]> {
  return exec
    .update(deviceAction)
    .set({ state: 'expired', completedAt: now, updatedAt: now })
    .where(and(inArray(deviceAction.state, ['queued', 'dispatched', 'awaiting_approval']), lt(deviceAction.expiresAt, now)))
    .returning();
}

export async function countDeviceActionsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceAction)
    .where(and(eq(deviceAction.orgId, orgId), gte(deviceAction.createdAt, since)));
  return Number(r?.n ?? 0);
}

// ---------- wake attempts (section 8.1) ----------

export async function insertWakeAttempt(exec: Executor, input: typeof wakeAttempt.$inferInsert): Promise<WakeAttemptRow> {
  const [row] = await exec.insert(wakeAttempt).values(input).returning();
  return row!;
}

export async function getWakeAttempt(exec: Executor, id: string): Promise<WakeAttemptRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec.select().from(wakeAttempt).where(eq(wakeAttempt.id, id)).limit(1);
  return row ?? null;
}

export async function transitionWakeAttempt(
  exec: Executor,
  id: string,
  to: WakeState,
  from: readonly WakeState[],
  set: Partial<Pick<WakeAttemptRow, 'via' | 'cause' | 'confirmedAt'>> = {},
): Promise<WakeAttemptRow | null> {
  const [row] = await exec
    .update(wakeAttempt)
    .set({ ...set, state: to })
    .where(and(eq(wakeAttempt.id, id), inArray(wakeAttempt.state, [...from])))
    .returning();
  return row ?? null;
}

/** Open attempts of a device (a reconnect inside the window confirms them, W3). */
export async function listOpenWakeAttempts(exec: Executor, deviceId: string): Promise<WakeAttemptRow[]> {
  return exec
    .select()
    .from(wakeAttempt)
    .where(and(eq(wakeAttempt.deviceId, deviceId), inArray(wakeAttempt.state, ['pending', 'dispatched'])));
}

/** Sweeper: open attempts older than `before` (no confirmation within `wakeConfirmSec`). */
export async function listStaleWakeAttempts(exec: Executor, before: Date): Promise<WakeAttemptRow[]> {
  return exec
    .select()
    .from(wakeAttempt)
    .where(and(inArray(wakeAttempt.state, ['pending', 'dispatched']), lt(wakeAttempt.createdAt, before)));
}

export async function countWakeAttemptsSince(exec: Executor, orgId: string, since: Date): Promise<number> {
  const [r] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(wakeAttempt)
    .where(and(eq(wakeAttempt.orgId, orgId), gte(wakeAttempt.createdAt, since)));
  return Number(r?.n ?? 0);
}

// ---------- AMT SOL (rule 8.4d) ----------

export async function insertAmtSol(exec: Executor, input: typeof amtSol.$inferInsert): Promise<AmtSolRow> {
  const [row] = await exec.insert(amtSol).values(input).returning();
  return row!;
}

export async function getAmtSol(exec: Executor, id: string): Promise<AmtSolRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await exec.select().from(amtSol).where(eq(amtSol.id, id)).limit(1);
  return row ?? null;
}

/** Closes an open SOL session once; null when already closed. */
export async function closeAmtSol(
  exec: Executor,
  id: string,
  set: { transcriptRef?: string | null; transcriptSha256?: string | null; closedAt?: Date } = {},
): Promise<AmtSolRow | null> {
  const [row] = await exec
    .update(amtSol)
    .set({ closedAt: set.closedAt ?? new Date(), transcriptRef: set.transcriptRef ?? null, transcriptSha256: set.transcriptSha256 ?? null })
    .where(and(eq(amtSol.id, id), isNull(amtSol.closedAt)))
    .returning();
  return row ?? null;
}

/** Sweeper: SOL sessions open longer than `before`. */
export async function listOpenAmtSolsBefore(exec: Executor, before: Date): Promise<AmtSolRow[]> {
  return exec
    .select()
    .from(amtSol)
    .where(and(isNull(amtSol.closedAt), lt(amtSol.openedAt, before)));
}
