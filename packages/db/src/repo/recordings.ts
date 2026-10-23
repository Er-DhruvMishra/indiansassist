/** recording repository (contracts sections 4.2, 6.10, 9). One recording per session in Phase A. */
import { LIMITS, type Region } from '@indiansassist/shared';
import { and, asc, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { NotFoundError } from '../errors.js';
import { org, recording, type RecordingRow } from '../schema/index.js';

export type InsertRecordingInput = {
  id?: string;
  orgId: string;
  sessionId: string;
  uploadedBy: string;
  storageKey: string;
  region: Region;
  mime?: string;
  bytes?: number;
  durationMs?: number | null;
  uploadId?: string | null;
  uploadExpiresAt?: Date | null;
};

/** `<region>/<orgId>/<sessionId>/<recordingId>.<ext>` (section 9; `jsonl.gz` for rrweb mirror recordings, Phase B 4.7). */
export function recordingStorageKey(region: Region, orgId: string, sessionId: string, recordingId: string, ext = 'webm'): string {
  return `${region}/${orgId}/${sessionId}/${recordingId}.${ext}`;
}

export async function insertRecording(exec: Executor, input: InsertRecordingInput): Promise<RecordingRow> {
  const [row] = await exec
    .insert(recording)
    .values({
      ...(input.id ? { id: input.id } : {}),
      orgId: input.orgId,
      sessionId: input.sessionId,
      uploadedBy: input.uploadedBy,
      storageKey: input.storageKey,
      region: input.region,
      mime: input.mime ?? 'video/webm',
      bytes: input.bytes ?? 0,
      durationMs: input.durationMs ?? null,
      uploadId: input.uploadId ?? null,
      uploadExpiresAt: input.uploadExpiresAt ?? null,
      status: 'uploading',
    })
    .returning();
  return row!;
}

export async function getRecording(exec: Executor, id: string): Promise<RecordingRow | null> {
  const [row] = await exec.select().from(recording).where(eq(recording.id, id)).limit(1);
  return row ?? null;
}

export async function getRecordingBySession(exec: Executor, sessionId: string): Promise<RecordingRow | null> {
  const [row] = await exec.select().from(recording).where(eq(recording.sessionId, sessionId)).limit(1);
  return row ?? null;
}

export async function getRecordingByUploadId(exec: Executor, uploadId: string): Promise<RecordingRow | null> {
  const [row] = await exec.select().from(recording).where(eq(recording.uploadId, uploadId)).limit(1);
  return row ?? null;
}

/** All recordings of a session (at most one in Phase A; a list keeps Phase B multi-recording additive). */
export async function listRecordingsBySession(exec: Executor, sessionId: string): Promise<RecordingRow[]> {
  return exec.select().from(recording).where(eq(recording.sessionId, sessionId)).orderBy(asc(recording.createdAt));
}

/** Reuses a failed / stale row for a fresh upload (section 6.10): status back to `uploading`. */
export async function resetRecordingForUpload(
  exec: Executor,
  id: string,
  patch: {
    mime?: string;
    bytes?: number;
    durationMs?: number | null;
    uploadId?: string | null;
    uploadExpiresAt?: Date | null;
  },
): Promise<RecordingRow> {
  const [row] = await exec
    .update(recording)
    .set({ ...patch, status: 'uploading', sha256: null, storedAt: null, chainedInto: null })
    .where(eq(recording.id, id))
    .returning();
  if (!row) throw new NotFoundError('recording', id);
  return row;
}

export async function markRecordingStored(
  exec: Executor,
  id: string,
  input: { sha256: string; bytes: number; chainedInto?: string | null; storedAt?: Date },
): Promise<RecordingRow> {
  const [row] = await exec
    .update(recording)
    .set({
      status: 'stored',
      sha256: input.sha256,
      bytes: input.bytes,
      storedAt: input.storedAt ?? new Date(),
      uploadExpiresAt: null,
      ...(input.chainedInto !== undefined ? { chainedInto: input.chainedInto } : {}),
    })
    .where(eq(recording.id, id))
    .returning();
  if (!row) throw new NotFoundError('recording', id);
  return row;
}

export async function setRecordingChainedInto(exec: Executor, id: string, entryId: string): Promise<RecordingRow> {
  const [row] = await exec.update(recording).set({ chainedInto: entryId }).where(eq(recording.id, id)).returning();
  if (!row) throw new NotFoundError('recording', id);
  return row;
}

export async function markRecordingFailed(exec: Executor, id: string): Promise<RecordingRow> {
  const [row] = await exec
    .update(recording)
    .set({ status: 'failed', uploadExpiresAt: null })
    .where(eq(recording.id, id))
    .returning();
  if (!row) throw new NotFoundError('recording', id);
  return row;
}

/** Sweeper (section 9 Expiry): `uploading` rows whose upload window passed. */
export async function listExpiredUploads(exec: Executor, now: Date = new Date()): Promise<RecordingRow[]> {
  return exec
    .select()
    .from(recording)
    .where(
      and(eq(recording.status, 'uploading'), isNotNull(recording.uploadExpiresAt), lt(recording.uploadExpiresAt, now)),
    );
}

/** `created_at + 24 h` default for chunked uploads. */
export function defaultUploadExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

export const RECORDING_PART_SIZE = LIMITS.recordingPartSize;

/** Quota inputs (storage quotas, section 6.10): open uploads of an org / a user and the org's bytes in storage. */
export async function recordingUsage(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<{ orgUploading: number; userUploading: number; orgBytes: number }> {
  const [row] = await exec
    .select({
      orgUploading: sql<number>`count(*) filter (where ${recording.status} = 'uploading')`.mapWith(Number),
      userUploading: sql<number>`count(*) filter (where ${recording.status} = 'uploading' and ${recording.uploadedBy} = ${userId})`.mapWith(Number),
      orgBytes: sql<number>`coalesce(sum(${recording.bytes}), 0)`.mapWith(Number),
    })
    .from(recording)
    .where(and(eq(recording.orgId, orgId), ne(recording.status, 'failed'), isNull(recording.deletedAt)));
  return { orgUploading: row?.orgUploading ?? 0, userUploading: row?.userUploading ?? 0, orgBytes: row?.orgBytes ?? 0 };
}

/** Phase B Y26: marks a recording's object deleted (the row stays, the chain references it). Null when already deleted. */
export async function markRecordingDeleted(
  exec: Executor,
  id: string,
  deletedBy: string | null,
  at: Date = new Date(),
): Promise<RecordingRow | null> {
  const [row] = await exec
    .update(recording)
    .set({ deletedAt: at, deletedBy, uploadExpiresAt: null })
    .where(and(eq(recording.id, id), isNull(recording.deletedAt)))
    .returning();
  return row ?? null;
}

/** Retention sweep (Y26): stored, not deleted recordings older than their org's `recording_retention_days`. */
export async function listRecordingsPastRetention(exec: Executor, now: Date = new Date(), limit = 100): Promise<RecordingRow[]> {
  const rows = await exec
    .select({ r: recording })
    .from(recording)
    .innerJoin(org, eq(org.id, recording.orgId))
    .where(
      and(
        eq(recording.status, 'stored'),
        isNull(recording.deletedAt),
        isNotNull(org.recordingRetentionDays),
        isNotNull(recording.storedAt),
        sql`${recording.storedAt} < ${now.toISOString()}::timestamptz - make_interval(days => ${org.recordingRetentionDays})`,
      ),
    )
    .limit(limit);
  return rows.map((x) => x.r);
}
