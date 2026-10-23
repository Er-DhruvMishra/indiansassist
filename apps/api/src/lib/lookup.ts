/** Batched reads used to hydrate wire objects (names of users, session refs). */
import { recording, token as tokenTable, user, type Executor, type SessionRow } from '@indiansassist/db';
import { inArray } from 'drizzle-orm';
import { toSession, type UserRef } from './mappers.js';
import type { Session } from '@indiansassist/shared';

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

/** Wire sessions with tokenCreatedBy, assist and recordingId resolved in three queries. */
export async function hydrateSessions(exec: Executor, rows: SessionRow[]): Promise<Session[]> {
  if (rows.length === 0) return [];
  const tokenIds = [...new Set(rows.map((r) => r.tokenId))];
  const toks = await exec
    .select({ id: tokenTable.id, createdBy: tokenTable.createdBy })
    .from(tokenTable)
    .where(inArray(tokenTable.id, tokenIds));
  const creatorOf = new Map(toks.map((t) => [t.id, t.createdBy]));
  const recs = await exec
    .select({ id: recording.id, sessionId: recording.sessionId })
    .from(recording)
    .where(inArray(recording.sessionId, rows.map((r) => r.id)));
  const recOf = new Map(recs.map((r) => [r.sessionId, r.id]));
  const names = await userRefs(exec, [...rows.map((r) => r.assistUserId), ...toks.map((t) => t.createdBy)]);
  return rows.map((r) =>
    toSession(r, {
      tokenCreatedBy: refOf(names, creatorOf.get(r.tokenId) ?? r.assistUserId),
      assist: refOf(names, r.assistUserId),
      recordingId: recOf.get(r.id) ?? null,
    }),
  );
}

export async function hydrateSession(exec: Executor, row: SessionRow): Promise<Session> {
  const [s] = await hydrateSessions(exec, [row]);
  return s!;
}
