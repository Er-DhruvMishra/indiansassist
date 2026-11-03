/**
 * Phase F section 6.5a: the camera's recordings are separate `recording` rows (`source = 'camera'`, `camera_id`), one
 * per camera per recorder (`recorded_by` `assist` for the console, `server` for the A.2 recorder). Their chain entries
 * are the existing `recording.stored` / `recording.failed` shapes plus `cameraId` (F0-1), so playback, retention,
 * deletion and residency counts treat them as any other recording.
 */
import { randomUUID } from 'node:crypto';
import type { RecordingSource } from '@indiansassist/shared';
import {
  insertRecording,
  markRecordingFailed,
  markRecordingStored,
  recording,
  recordingStorageKey,
  resetRecordingForUpload,
  setRecordingChainedInto,
  type OrgRow,
  type RecordingRow,
  type SessionRow,
} from '@indiansassist/db';
import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { systemActor, writeAudit, type Actor } from '../lib/audit.js';

const STALE_UPLOAD_MS = 60 * 60_000;

/** The camera recording of one recorder (`assist` = the console, `server` = the A.2 recorder) of a session. */
export async function getCameraRecording(
  ctx: AppContext,
  sessionId: string,
  cameraId: string,
  recordedBy: RecordingSource,
): Promise<RecordingRow | null> {
  const [row] = await ctx.db
    .select()
    .from(recording)
    .where(
      and(eq(recording.sessionId, sessionId), eq(recording.cameraId, cameraId), eq(recording.recordedBy, recordedBy)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * A row in `uploading` for a camera upload: new, or the camera's failed / stale row reused. A stored row is
 * `409 recording_exists` (with its sha256, so the recorder's retry after a lost reply is recognised).
 */
export async function prepareCameraRecording(
  ctx: AppContext,
  s: SessionRow,
  cameraId: string,
  recordedBy: RecordingSource,
  uploadedBy: string | null,
  input: { mime: string; bytes?: number; durationMs?: number | null },
): Promise<RecordingRow> {
  const existing = await getCameraRecording(ctx, s.id, cameraId, recordedBy);
  const patch = {
    mime: input.mime,
    bytes: input.bytes ?? 0,
    durationMs: input.durationMs ?? null,
    uploadId: null,
    uploadExpiresAt: new Date(Date.now() + STALE_UPLOAD_MS),
  };
  if (existing) {
    const details = { recordingId: existing.id, status: existing.status, sha256: existing.sha256 ?? null };
    if (existing.status === 'stored') fail('recording_exists', 'this camera already has a stored recording', details);
    const stale = existing.status === 'failed' || Date.now() - existing.createdAt.getTime() > STALE_UPLOAD_MS;
    if (!stale) fail('recording_exists', 'an upload of this camera recording is in progress', details);
    return resetRecordingForUpload(ctx.db, existing.id, patch);
  }
  const id = randomUUID();
  return insertRecording(ctx.db, {
    id,
    orgId: s.orgId,
    sessionId: s.id,
    uploadedBy,
    recordedBy,
    storageKey: recordingStorageKey(s.region, s.orgId, s.id, id, 'webm'),
    region: s.region,
    mime: input.mime,
    bytes: patch.bytes,
    durationMs: patch.durationMs,
    uploadExpiresAt: patch.uploadExpiresAt,
    cameraId,
  });
}

const sourceOf = (rec: RecordingRow) => (rec.recordedBy === 'server' ? { source: 'server' as const } : {});

/** `status = stored`, `recording.stored { ..., cameraId }`, `chained_into`, in one transaction. */
export async function finaliseCameraRecording(
  ctx: AppContext,
  org: OrgRow,
  rec: RecordingRow,
  actor: Actor,
  result: { sha256: string; bytes: number },
): Promise<RecordingRow> {
  return ctx.db.transaction(async (tx) => {
    await markRecordingStored(tx, rec.id, { sha256: result.sha256, bytes: result.bytes });
    const entry = await writeAudit(ctx, tx, org, {
      sessionId: rec.sessionId,
      actor,
      action: 'recording.stored',
      data: {
        recordingId: rec.id,
        sha256: result.sha256,
        bytes: result.bytes,
        mime: rec.mime,
        storageKey: rec.storageKey,
        ...sourceOf(rec),
        ...(rec.cameraId ? { cameraId: rec.cameraId } : {}),
      },
    });
    return setRecordingChainedInto(tx, rec.id, entry.id);
  });
}

/** `status = failed` plus `recording.failed { recordingId, error, cameraId }`. */
export async function failCameraRecording(
  ctx: AppContext,
  org: OrgRow,
  rec: RecordingRow,
  error: string,
  actor: Actor = systemActor,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await markRecordingFailed(tx, rec.id);
    await writeAudit(ctx, tx, org, {
      sessionId: rec.sessionId,
      actor,
      action: 'recording.failed',
      data: { recordingId: rec.id, error, ...sourceOf(rec), ...(rec.cameraId ? { cameraId: rec.cameraId } : {}) },
    });
  });
}
