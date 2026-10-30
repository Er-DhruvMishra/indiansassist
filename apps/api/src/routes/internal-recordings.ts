/**
 * `POST /api/v1/internal/recordings` (docs/specs/phase-a2-recorder.md section 9): the server recorder uploads a
 * finished WebM with its declared sha256 and byte count, authenticated by the service token (no cookie). The body is
 * streamed through sha256 into ObjectStorage; a mismatch with the declaration fails the row. One server recording per
 * session (`recorded_by = 'server'`); a failed or stale row is reused as in Phase A section 6.10.
 */
import { randomUUID } from 'node:crypto';
import {
  internalRecordingMetaSchema,
  isRegionServed,
  LIMITS,
  recorderActor,
  serverRecords,
  type InternalRecordingMeta,
} from '@indiansassist/shared';
import {
  getOrgOrThrow,
  getRecordingBySession,
  getSession,
  insertRecording,
  recordingStorageKey,
  recordingUsage,
  resetRecordingForUpload,
  type RecordingRow,
  type SessionRow,
} from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, HttpError } from '../errors.js';
import { toRecording } from '../lib/mappers.js';
import { requireRecorder } from '../lib/recorder-auth.js';
import { parseOr400 } from '../lib/validate.js';
import { failRecording, finaliseRecording } from '../services/recording-service.js';

const STALE_UPLOAD_MS = 60 * 60_000;
/** Any uuid that is never a user id: server rows have no uploader, so no "per user" quota applies. */
const NO_USER = '00000000-0000-4000-8000-000000000000';

/** Every precondition of section 9 "Server checks" except the token. */
async function uploadableSession(ctx: AppContext, meta: InternalRecordingMeta): Promise<SessionRow> {
  const s = await getSession(ctx.db, meta.sessionId);
  if (!s || !isRegionServed(s.region, ctx.config.servedRegions)) fail('not_found', 'session not found');
  if (s.startedAt === null) fail('forbidden', 'the session never reached active (no consent was given)');
  if ((s.tier !== 'p1_browser' && s.tier !== 'p3_portable') || !serverRecords(s.recordingMode))
    fail('forbidden', 'server recording is not enabled for this session');
  const q = ctx.config.recordingQuota;
  if (s.endedAt && Date.now() > s.endedAt.getTime() + q.uploadWindowSec * 1000)
    fail('already_ended', 'the upload window for this session has closed');
  const usage = await recordingUsage(ctx.db, s.orgId, NO_USER);
  const existing = await getRecordingBySession(ctx.db, s.id, 'server');
  const reuseBytes = existing && existing.status === 'uploading' ? existing.bytes : 0;
  if (q.orgBytes > 0 && usage.orgBytes - reuseBytes + meta.bytes > q.orgBytes)
    fail('payload_too_large', 'the organisation recording storage quota is exhausted');
  return s;
}

/** A row in `uploading` for this upload; `409 recording_exists` (with the stored sha256) when one is stored. */
async function prepareServerRecording(
  ctx: AppContext,
  s: SessionRow,
  meta: InternalRecordingMeta,
): Promise<RecordingRow> {
  const existing = await getRecordingBySession(ctx.db, s.id, 'server');
  const patch = {
    mime: meta.mime,
    bytes: meta.bytes,
    durationMs: meta.durationMs,
    uploadId: null,
    uploadExpiresAt: new Date(Date.now() + STALE_UPLOAD_MS),
  };
  if (existing) {
    const details = { recordingId: existing.id, status: existing.status, sha256: existing.sha256 ?? null };
    if (existing.status === 'stored')
      fail('recording_exists', 'this session already has a stored server recording', details);
    const stale = existing.status === 'failed' || Date.now() - existing.createdAt.getTime() > STALE_UPLOAD_MS;
    if (!stale) fail('recording_exists', 'a server upload for this session is in progress', details);
    return resetRecordingForUpload(ctx.db, existing.id, patch);
  }
  const id = randomUUID();
  return insertRecording(ctx.db, {
    id,
    orgId: s.orgId,
    sessionId: s.id,
    uploadedBy: null,
    recordedBy: 'server',
    storageKey: recordingStorageKey(s.region, s.orgId, s.id, id, 'webm'),
    region: s.region,
    mime: meta.mime,
    bytes: meta.bytes,
    durationMs: meta.durationMs,
    uploadExpiresAt: patch.uploadExpiresAt,
  });
}

export async function internalRecordingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/api/v1/internal/recordings', async (req, reply) => {
    requireRecorder(ctx.config, req);
    if (!req.isMultipart()) fail('validation_failed', 'expected multipart/form-data');
    let meta: InternalRecordingMeta | null = null;
    let stored: RecordingRow | null = null;
    for await (const part of req.parts({
      limits: { fileSize: LIMITS.recordingMaxBytes, files: 1, fields: 5, parts: 10 },
    })) {
      if (part.type === 'field') {
        if (part.fieldname !== 'meta') continue;
        let json: unknown;
        try {
          json = JSON.parse(String(part.value));
        } catch {
          fail('validation_failed', 'meta must be a JSON string');
        }
        meta = parseOr400(internalRecordingMetaSchema, json);
        continue;
      }
      if (part.fieldname !== 'file') {
        part.file.resume();
        continue;
      }
      if (!meta) fail('validation_failed', 'the meta field must precede the file field');
      if (stored) fail('validation_failed', 'one file per upload');
      const s = await uploadableSession(ctx, meta);
      const org = await getOrgOrThrow(ctx.db, s.orgId);
      const rec = await prepareServerRecording(ctx, s, meta);
      const actor = recorderActor(meta.recorderId);
      let result: { bytes: number; sha256: string };
      try {
        result = await ctx.storage.put(rec.storageKey, part.file, { contentType: 'video/webm' });
        if (part.file.truncated) throw new HttpError('payload_too_large', 'recording exceeds 2 GiB');
        if (result.sha256 !== meta.sha256 || result.bytes !== meta.bytes)
          throw new HttpError('validation_failed', 'sha256 or byte count does not match the declaration');
      } catch (err) {
        await ctx.storage.delete(rec.storageKey).catch(() => undefined);
        const mismatch = err instanceof HttpError && err.code === 'validation_failed';
        const tooLarge = (err instanceof HttpError && err.code === 'payload_too_large') || part.file.truncated;
        await failRecording(
          ctx,
          org,
          rec,
          mismatch ? 'sha256_mismatch' : tooLarge ? 'payload_too_large' : 'storage_error',
          actor,
        );
        ctx.log.warn(
          { sessionId: s.id, recordingId: rec.id, recorderId: meta.recorderId, mismatch },
          'server recording upload failed',
        );
        throw err;
      }
      stored = await finaliseRecording(ctx, org, rec, actor, result);
      ctx.log.info(
        { sessionId: s.id, recordingId: rec.id, recorderId: meta.recorderId, bytes: result.bytes },
        'server recording stored',
      );
    }
    if (!stored) fail('validation_failed', 'missing file field');
    return reply.status(201).send(toRecording(stored));
  });
}
