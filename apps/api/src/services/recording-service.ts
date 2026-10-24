/**
 * Recording storage flow (contracts sections 6.10, 9): row reuse rules, finalising a stored object into the audit
 * chain (`recording.stored`, `chained_into`) and failure handling (`recording.failed`).
 */
import { randomUUID } from 'node:crypto';
import { LIMITS, recordingFileExtension, recordingMediaType, RRWEB_RECORDING_MIME } from '@indiansassist/shared';
import {
  getRecordingBySession,
  insertRecording,
  recordingUsage,
  markRecordingFailed,
  markRecordingStored,
  recordingStorageKey,
  resetRecordingForUpload,
  setRecordingChainedInto,
  type OrgRow,
  type RecordingRow,
  type SessionRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail, HttpError } from '../errors.js';
import { systemActor, writeAudit, type Actor } from '../lib/audit.js';
import { requireAssistMayRecord } from './scope.js';

const STALE_UPLOAD_MS = 60 * 60_000;

/** Phase A.2: `source: 'server'` on the entries of a server recording only (Phase A shapes unchanged). */
function sourceOf(rec: Pick<RecordingRow, 'recordedBy'>): { source?: 'server' } {
  return rec.recordedBy === 'server' ? { source: 'server' } : {};
}

/** Storage key suffix: `jsonl.gz` for rrweb mirror recordings (Phase B 4.7), `webm` otherwise (section 9). */
function storageExt(mime: string): string {
  return recordingMediaType(mime) === RRWEB_RECORDING_MIME ? recordingFileExtension(RRWEB_RECORDING_MIME) : 'webm';
}

export function partKey(storageKey: string, n: number): string {
  return `${storageKey}.part${n}`;
}

export function partsOf(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / LIMITS.recordingPartSize));
}

/** Deletes every `.part<n>` object a declared size implies (idempotent). */
export async function deleteParts(ctx: AppContext, rec: RecordingRow): Promise<void> {
  if (!rec.uploadId || rec.bytes <= 0) return;
  const n = partsOf(rec.bytes);
  for (let i = 1; i <= n; i++) await ctx.storage.delete(partKey(rec.storageKey, i));
}

/**
 * Upload rules beyond the row reuse (SEC-06, SEC-08): the session must have reached `active`, uploads close
 * `uploadWindowSec` after it ended, and the org / user quotas on open uploads and stored bytes apply.
 */
export async function assertCanUpload(
  ctx: AppContext,
  s: SessionRow,
  uploadedBy: string,
  declaredBytes: number,
): Promise<void> {
  if (s.startedAt === null) fail('forbidden', 'the session never reached active (no consent was given)');
  requireAssistMayRecord(s);
  const q = ctx.config.recordingQuota;
  if (s.endedAt && Date.now() > s.endedAt.getTime() + q.uploadWindowSec * 1000)
    fail('already_ended', 'the upload window for this session has closed');
  const usage = await recordingUsage(ctx.db, s.orgId, uploadedBy);
  const existing = await getRecordingBySession(ctx.db, s.id);
  // A reusable row of this session is replaced, not added: do not count it twice.
  const reuse = existing && existing.status === 'uploading' ? existing : null;
  const orgOpen = usage.orgUploading - (reuse ? 1 : 0);
  const userOpen = usage.userUploading - (reuse && reuse.uploadedBy === uploadedBy ? 1 : 0);
  const orgBytes = usage.orgBytes - (reuse?.bytes ?? 0);
  if (orgOpen >= q.orgOpenUploads)
    throw new HttpError('rate_limited', 'too many recording uploads in progress for this organisation', { retryAfterSec: 60 });
  if (userOpen >= q.userOpenUploads)
    throw new HttpError('rate_limited', 'you have too many recording uploads in progress', { retryAfterSec: 60 });
  if (q.orgBytes > 0 && orgBytes + declaredBytes > q.orgBytes)
    fail('payload_too_large', 'the organisation recording storage quota is exhausted');
}

/**
 * Returns a row in `uploading` for a new upload: a new row, or the session's `failed` row / an `uploading` row older
 * than 1 h reused with the same id and key (stale parts deleted). A `stored` row is `409 recording_exists`.
 */
export async function prepareRecording(
  ctx: AppContext,
  s: SessionRow,
  uploadedBy: string,
  input: { mime: string; durationMs?: number | undefined; bytes?: number; uploadId?: string | null },
): Promise<RecordingRow> {
  const existing = await getRecordingBySession(ctx.db, s.id);
  const patch = {
    mime: input.mime,
    bytes: input.bytes ?? 0,
    durationMs: input.durationMs ?? null,
    uploadId: input.uploadId ?? null,
    // Chunked uploads stay open 24 h; a single upload streams in one request, so a row still `uploading` after
    // 1 h was abandoned (crash mid-stream) and the sweeper fails it, freeing the open-upload quota (SEC-08).
    uploadExpiresAt: new Date(Date.now() + (input.uploadId ? 24 * 60 * 60_000 : STALE_UPLOAD_MS)),
  };
  if (existing) {
    if (existing.status === 'stored') fail('recording_exists', 'this session already has a stored recording');
    const stale = existing.status === 'failed' || Date.now() - existing.createdAt.getTime() > STALE_UPLOAD_MS;
    if (!stale) fail('recording_exists', 'an upload for this session is in progress');
    await deleteParts(ctx, existing);
    return resetRecordingForUpload(ctx.db, existing.id, patch);
  }
  const id = randomUUID();
  return insertRecording(ctx.db, {
    id,
    orgId: s.orgId,
    sessionId: s.id,
    uploadedBy,
    storageKey: recordingStorageKey(s.region, s.orgId, s.id, id, storageExt(input.mime)),
    region: s.region,
    mime: input.mime,
    bytes: input.bytes ?? 0,
    durationMs: input.durationMs ?? null,
    uploadId: input.uploadId ?? null,
    uploadExpiresAt: patch.uploadExpiresAt,
  });
}

/** `status = stored`, audit `recording.stored`, `chained_into` = that entry, in one transaction. */
export async function finaliseRecording(
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
      },
    });
    return setRecordingChainedInto(tx, rec.id, entry.id);
  });
}

/** `status = failed` plus `recording.failed { recordingId, error }`. */
export async function failRecording(
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
      data: { recordingId: rec.id, error, ...sourceOf(rec) },
    });
  });
}
