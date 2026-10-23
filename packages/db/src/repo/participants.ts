/** session_participant and session_file repositories (contracts sections 4.2, 6.8, 7.5). */
import type { FileDirection, ParticipantRole } from '@indiansassist/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { sessionFile, sessionParticipant, type SessionFileRow, type SessionParticipantRow } from '../schema/index.js';

export type AddParticipantInput = {
  sessionId: string;
  role: ParticipantRole;
  userId?: string | null;
  label: string;
  connectionId: string;
  joinedAt?: Date;
};

export async function addParticipant(exec: Executor, input: AddParticipantInput): Promise<SessionParticipantRow> {
  const [row] = await exec
    .insert(sessionParticipant)
    .values({
      sessionId: input.sessionId,
      role: input.role,
      userId: input.userId ?? null,
      label: input.label,
      connectionId: input.connectionId,
      ...(input.joinedAt ? { joinedAt: input.joinedAt } : {}),
    })
    .returning();
  return row!;
}

/** Sets `left_at` on every open row of `role` in the session; returns how many were closed. */
export async function closeParticipants(
  exec: Executor,
  sessionId: string,
  role: ParticipantRole,
  at: Date = new Date(),
): Promise<number> {
  const rows = await exec
    .update(sessionParticipant)
    .set({ leftAt: at })
    .where(
      and(
        eq(sessionParticipant.sessionId, sessionId),
        eq(sessionParticipant.role, role),
        isNull(sessionParticipant.leftAt),
      ),
    )
    .returning({ id: sessionParticipant.id });
  return rows.length;
}

/** Resume (section 7.5): closes the side's previous row and inserts one with the new connection id. */
export async function replaceParticipant(exec: Executor, input: AddParticipantInput): Promise<SessionParticipantRow> {
  return exec.transaction(async (tx) => {
    await closeParticipants(tx, input.sessionId, input.role, input.joinedAt ?? new Date());
    return addParticipant(tx, input);
  });
}

/** Closes every open participant row of a session (session end). */
export async function closeAllParticipants(exec: Executor, sessionId: string, at: Date = new Date()): Promise<number> {
  const rows = await exec
    .update(sessionParticipant)
    .set({ leftAt: at })
    .where(and(eq(sessionParticipant.sessionId, sessionId), isNull(sessionParticipant.leftAt)))
    .returning({ id: sessionParticipant.id });
  return rows.length;
}

export async function listParticipants(exec: Executor, sessionId: string): Promise<SessionParticipantRow[]> {
  return exec
    .select()
    .from(sessionParticipant)
    .where(eq(sessionParticipant.sessionId, sessionId))
    .orderBy(asc(sessionParticipant.joinedAt), asc(sessionParticipant.id));
}

// ---------- session_file ----------

export type FileReport = {
  sessionId: string;
  direction: FileDirection;
  fileId: number;
  /** Output of sanitiseFileName (section 8.3). */
  name: string;
  bytes: number;
  sha256: string;
  /** Which side reported it; selects assist_* or desk_* columns. */
  side: 'assist' | 'desk';
  entryId: string;
};

/** Upserts the attestation row of one transfer from one side's report (section 6.8 `file.*`). */
export async function upsertSessionFile(exec: Executor, r: FileReport): Promise<SessionFileRow> {
  const sideCols =
    r.side === 'assist'
      ? { assistSha256: r.sha256, assistEntryId: r.entryId }
      : { deskSha256: r.sha256, deskEntryId: r.entryId };
  const [row] = await exec
    .insert(sessionFile)
    .values({
      sessionId: r.sessionId,
      direction: r.direction,
      fileId: r.fileId,
      name: r.name,
      bytes: r.bytes,
      ...sideCols,
    })
    .onConflictDoUpdate({
      target: [sessionFile.sessionId, sessionFile.direction, sessionFile.fileId],
      set: { ...sideCols, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function listSessionFiles(exec: Executor, sessionId: string): Promise<SessionFileRow[]> {
  return exec
    .select()
    .from(sessionFile)
    .where(eq(sessionFile.sessionId, sessionId))
    .orderBy(asc(sessionFile.createdAt), asc(sessionFile.fileId));
}

/** `match` of the wire SessionFile: null until both sides reported. */
export function sessionFileMatch(row: Pick<SessionFileRow, 'assistSha256' | 'deskSha256'>): boolean | null {
  if (!row.assistSha256 || !row.deskSha256) return null;
  return row.assistSha256 === row.deskSha256;
}
