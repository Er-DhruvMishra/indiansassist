/**
 * Recording routes (contracts sections 6.10, 9): single multipart upload streamed through sha256 into the
 * ObjectStorage adapter, chunked uploads (init / parts / complete), metadata, presigned download, the fs driver's
 * signed file route and re-hash verification.
 */
import { Readable } from 'node:stream';
import {
  isRegionServed,
  LIMITS,
  recordingCompleteRequestSchema,
  recordingFileQuerySchema,
  recordingMetaSchema,
  recordingUploadInitRequestSchema,
} from '@indiansassist/shared';
import { getAuditEntry, getRecording, getRecordingByUploadId, getSession, type RecordingRow } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import { hashStream, ObjectNotFoundError } from '../adapters/storage.js';
import type { AppContext } from '../context.js';
import { fail, HttpError } from '../errors.js';
import { userActor } from '../lib/audit.js';
import { presignSignature, randomSecret, safeEqual } from '../lib/crypto.js';
import { toRecording } from '../lib/mappers.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import {
  assertCanUpload,
  deleteParts,
  failRecording,
  finaliseRecording,
  partKey,
  partsOf,
  prepareRecording,
} from '../services/recording-service.js';
import { requireSessionAssist, scopedSession, UUID_RE } from '../services/scope.js';

const PRESIGN_TTL_SEC = 600;

async function scopedRecording(ctx: AppContext, p: Principal, id: string): Promise<RecordingRow> {
  const rec = UUID_RE.test(id) ? await getRecording(ctx.db, id) : null;
  if (!rec || rec.orgId !== p.org.id) fail('not_found', 'recording not found');
  await scopedSession(ctx, p, rec.sessionId);
  return rec;
}

/** Recording reached through its upload id; the caller must be the assist of the session. */
async function uploadTarget(ctx: AppContext, p: Principal, uploadId: string): Promise<RecordingRow> {
  const rec = await getRecordingByUploadId(ctx.db, uploadId);
  if (!rec || rec.orgId !== p.org.id) fail('not_found', 'upload not found');
  const s = await getSession(ctx.db, rec.sessionId);
  if (!s) fail('not_found', 'upload not found');
  requireSessionAssist(p, s);
  if (rec.status !== 'uploading' || (rec.uploadExpiresAt && rec.uploadExpiresAt.getTime() < Date.now()))
    fail('not_found', 'upload is no longer open');
  return rec;
}

export async function recordingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: LIMITS.recordingPartSize },
    (_req, body, done) => done(null, body),
  );

  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/recordings', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    requireSessionAssist(p, session);
    await assertCanUpload(ctx, session, p.user.id, 0);
    if (!req.isMultipart()) fail('validation_failed', 'expected multipart/form-data');
    let meta: { mime: string; durationMs?: number | undefined } | null = null;
    let stored: RecordingRow | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'field') {
        if (part.fieldname !== 'meta') continue;
        let json: unknown;
        try {
          json = JSON.parse(String(part.value));
        } catch {
          fail('validation_failed', 'meta must be a JSON string');
        }
        meta = parseOr400(recordingMetaSchema, json);
        continue;
      }
      if (part.fieldname !== 'file') {
        part.file.resume();
        continue;
      }
      if (!meta) fail('validation_failed', 'the meta field must precede the file field');
      if (stored) fail('validation_failed', 'one file per upload');
      const rec = await prepareRecording(ctx, session, p.user.id, meta);
      let result: { bytes: number; sha256: string };
      try {
        result = await ctx.storage.put(rec.storageKey, part.file, { contentType: rec.mime });
        if (part.file.truncated) throw new HttpError('payload_too_large', 'recording exceeds 100 MiB');
        if (result.bytes === 0) throw new HttpError('validation_failed', 'the recording is empty');
      } catch (err) {
        await ctx.storage.delete(rec.storageKey).catch(() => undefined);
        const empty = err instanceof HttpError && err.code === 'validation_failed';
        const tooLarge =
          (err instanceof HttpError && err.code === 'payload_too_large') ||
          (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE' ||
          part.file.truncated;
        const reason = empty ? 'empty' : tooLarge ? 'payload_too_large' : 'storage_error';
        await failRecording(ctx, p.org, rec, reason, userActor(p.user));
        if (empty) fail('validation_failed', 'the recording is empty');
        if (tooLarge) fail('payload_too_large', 'recording exceeds 100 MiB');
        throw err;
      }
      stored = await finaliseRecording(ctx, p.org, rec, userActor(p.user), result);
    }
    if (!stored) fail('validation_failed', 'missing file field');
    return reply.status(201).send(toRecording(stored));
  });

  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/recordings/uploads', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    requireSessionAssist(p, session);
    const body = parseOr400(recordingUploadInitRequestSchema, req.body);
    if (body.bytes > LIMITS.recordingMaxBytes) fail('payload_too_large', 'recordings are limited to 2 GiB');
    await assertCanUpload(ctx, session, p.user.id, body.bytes);
    const rec = await prepareRecording(ctx, session, p.user.id, { ...body, uploadId: randomSecret(18) });
    return reply.status(201).send({
      uploadId: rec.uploadId!,
      recordingId: rec.id,
      partSize: LIMITS.recordingPartSize,
      parts: partsOf(body.bytes),
    });
  });

  app.put<{ Params: { uploadId: string; n: string } }>('/api/v1/recordings/uploads/:uploadId/parts/:n', async (req) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const lim = ctx.limiter.hit(`recording-parts:${p.user.id}`, 60, 60_000);
    if (!lim.allowed) fail('rate_limited', 'too many recording parts', { retryAfterSec: lim.retryAfterSec });
    const rec = await uploadTarget(ctx, p, req.params.uploadId);
    const parts = partsOf(rec.bytes);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1 || n > parts) fail('validation_failed', `n must be between 1 and ${parts}`);
    const body = req.body;
    if (!Buffer.isBuffer(body)) fail('validation_failed', 'expected application/octet-stream');
    const expected = n < parts ? LIMITS.recordingPartSize : rec.bytes - (parts - 1) * LIMITS.recordingPartSize;
    if (body.length !== expected) fail('validation_failed', `part ${n} must be exactly ${expected} bytes`);
    await ctx.storage.put(partKey(rec.storageKey, n), body, { contentType: 'application/octet-stream' });
    return { n, bytes: body.length };
  });

  app.post<{ Params: { uploadId: string } }>('/api/v1/recordings/uploads/:uploadId/complete', async (req) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const rec = await uploadTarget(ctx, p, req.params.uploadId);
    const body = parseOr400(recordingCompleteRequestSchema, req.body);
    const parts = partsOf(rec.bytes);
    if (body.parts !== parts) fail('validation_failed', `parts must equal ${parts}`);
    const missing: number[] = [];
    for (let i = 1; i <= parts; i++) if (!(await ctx.storage.head(partKey(rec.storageKey, i)))) missing.push(i);
    if (missing.length > 0) fail('upload_incomplete', 'some parts are missing', { missing });
    const storage = ctx.storage;
    async function* concat(): AsyncGenerator<Buffer> {
      for (let i = 1; i <= parts; i++) for await (const chunk of await storage.get(partKey(rec.storageKey, i))) yield chunk as Buffer;
    }
    const joined = Readable.from(concat());
    const result = await ctx.storage.put(rec.storageKey, joined, { contentType: rec.mime });
    if (result.bytes !== rec.bytes) {
      await ctx.storage.delete(rec.storageKey);
      fail('validation_failed', `assembled size ${result.bytes} does not equal declared ${rec.bytes}`);
    }
    await deleteParts(ctx, rec);
    return toRecording(await finaliseRecording(ctx, p.org, rec, userActor(p.user), result));
  });

  app.get<{ Params: { id: string } }>('/api/v1/recordings/:id', async (req) => {
    const p = await authenticate(ctx, req);
    return toRecording(await scopedRecording(ctx, p, req.params.id));
  });

  app.get<{ Params: { id: string } }>('/api/v1/recordings/:id/download', async (req) => {
    const p = await authenticate(ctx, req);
    const rec = await scopedRecording(ctx, p, req.params.id);
    if (rec.status !== 'stored') fail('not_found', 'recording is not stored');
    const url = await ctx.storage.presignGet(rec.storageKey, PRESIGN_TTL_SEC);
    return { url, expiresAt: iso(new Date(Date.now() + PRESIGN_TTL_SEC * 1000)) };
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/recordings/:id/file',
    { config: { rateLimit: false } },
    async (req, reply) => {
      const q = recordingFileQuerySchema.safeParse(req.query);
      const rec = UUID_RE.test(req.params.id) ? await getRecording(ctx.db, req.params.id) : null;
      if (!q.success || !rec || rec.status !== 'stored' || !isRegionServed(rec.region, ctx.config.servedRegions))
        fail('not_found', 'not found');
      const expected = presignSignature(ctx.presignKey, rec.id, rec.storageKey, q.data.exp);
      if (!safeEqual(expected, q.data.sig)) fail('not_found', 'not found');
      if (q.data.exp < Math.floor(Date.now() / 1000)) fail('link_expired', 'this download link has expired');
      const head = await ctx.storage.head(rec.storageKey);
      if (!head) fail('not_found', 'not found');
      // This route is served from API_ORIGIN (= WEB_ORIGIN in production): the bytes are uploaded by a user and
      // must never render as a document there (SEC-01). Fixed type, download only, no sniffing, sandboxed.
      void reply
        .header('Content-Type', 'video/webm')
        .header('Content-Length', String(head.bytes))
        .header('Content-Disposition', `attachment; filename="${rec.id}.webm"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('Cache-Control', 'private, no-store');
      return reply.send(await ctx.storage.get(rec.storageKey));
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/recordings/:id/verify', async (req) => {
    const p = await authenticate(ctx, req);
    const rec = await scopedRecording(ctx, p, req.params.id);
    let actual: { sha256: string; bytes: number } | null = null;
    try {
      actual = await hashStream(await ctx.storage.get(rec.storageKey));
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError)) throw err;
    }
    const entry = rec.chainedInto ? await getAuditEntry(ctx.db, rec.chainedInto) : null;
    const chainSha = typeof entry?.data['sha256'] === 'string' ? (entry.data['sha256'] as string) : null;
    const ok = actual !== null && actual.sha256 === rec.sha256 && actual.sha256 === chainSha;
    return {
      ok,
      sha256: actual?.sha256 ?? null,
      expectedSha256: rec.sha256 ?? null,
      chainSha256: chainSha,
      bytes: actual?.bytes ?? 0,
      chainedInto: rec.chainedInto ?? null,
    };
  });

}
