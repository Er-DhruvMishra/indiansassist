/** Batched reads used to hydrate wire objects (names of users, session refs). */
import { findSessionsAuditByAction, recording, token as tokenTable, user, type Executor, type SessionRow } from '@indiansassist/db';
import { inArray } from 'drizzle-orm';
import { toSession, type UserRef } from './mappers.js';
import type { ApprovedBy, Session } from '@indiansassist/shared';

export async function userRefs(exec: Executor, ids: Iterable<string>): Promise<Map<string, UserRef>> {
  const list = [...new Set(ids)];
  const out = new Map<string, UserRef>();
  if (list.length === 0) return out;
  const rows = await exec.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, list));
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name });
  return out;
}

export function refOf(map: Map<string, UserRef>, id: string): UserRef {
  return map.get(id) ?? { id, name: 'Unknown user' };
}

/**
 * Phase D section 6.3: `approvedBy` per unattended session, from the one `session.unattended_started` entry of its
 * chain (one query for the whole page; attended and non-device sessions are never looked up).
 */
export async function approvedByOf(exec: Executor, rows: readonly SessionRow[]): Promise<Map<string, ApprovedBy>> {
  const ids = rows.filter((r) => r.unattended === true).map((r) => r.id);
  const entries = await findSessionsAuditByAction(exec, ids, 'session.unattended_started');
  const out = new Map<string, ApprovedBy>();
  for (const [sessionId, e] of entries) {
    const by = (e.data as { approvedBy?: unknown }).approvedBy;
    if (by === 'policy' || by === 'local_user' || by === 'auto_after_timeout') out.set(sessionId, by);
  }
  return out;
}

/** Wire sessions with tokenCreatedBy, assist, recordingId and (Phase D) approvedBy resolved in four queries. */
export async function hydrateSessions(exec: Executor, rows: SessionRow[]): Promise<Session[]> {
  if (rows.length === 0) return [];
  const tokenIds = [...new Set(rows.map((r) => r.tokenId).filter((t): t is string => t !== null))];
  const toks =
    tokenIds.length === 0
      ? []
      : await exec
          .select({ id: tokenTable.id, createdBy: tokenTable.createdBy })
          .from(tokenTable)
          .where(inArray(tokenTable.id, tokenIds));
  const creatorOf = new Map(toks.map((t) => [t.id, t.createdBy]));
  const recs = await exec
    .select({ id: recording.id, sessionId: recording.sessionId, recordedBy: recording.recordedBy })
    .from(recording)
    .where(inArray(recording.sessionId, rows.map((r) => r.id)));
  const recOf = new Map(recs.filter((r) => r.recordedBy === 'assist').map((r) => [r.sessionId, r.id]));
  const serverRecOf = new Map(recs.filter((r) => r.recordedBy === 'server').map((r) => [r.sessionId, r.id]));
  const names = await userRefs(exec, [...rows.map((r) => r.assistUserId), ...toks.map((t) => t.createdBy)]);
  const approvals = await approvedByOf(exec, rows);
  return rows.map((r) =>
    toSession(r, {
      tokenCreatedBy: refOf(names, (r.tokenId ? creatorOf.get(r.tokenId) : undefined) ?? r.assistUserId),
      assist: refOf(names, r.assistUserId),
      recordingId: recOf.get(r.id) ?? null,
      serverRecordingId: serverRecOf.get(r.id) ?? null,
      approvedBy: approvals.get(r.id) ?? null,
    }),
  );
}

export async function hydrateSession(exec: Executor, row: SessionRow): Promise<Session> {
  const [s] = await hydrateSessions(exec, [row]);
  return s!;
}
