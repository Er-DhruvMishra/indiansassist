/**
 * Phase F stream camera (docs/specs/phase-f-contracts.md sections 6.2, 6.5a, 6.7): the camera link and snapshot
 * routes, and the console's camera recording upload. Registered through `PHASE_F_ROUTE_PLUGINS` in app.ts.
 *
 * - `POST /api/v1/sessions/:id/camera-links`: the session's Assist; `201 { cameraId, url, code, expiresAt }`.
 * - `DELETE /api/v1/sessions/:id/camera-links/:cameraId`: revokes a pending link or ends a connected camera.
 * - `POST /api/v1/sessions/:id/camera/:cameraId/snapshots`: `{ sha256, width, height }` chained, never the bytes.
 * - `POST /api/v1/sessions/:id/camera/:cameraId/recordings`: the console's separate camera recording (multipart
 *   `meta` + `file`, as `POST /sessions/:id/recordings`), stored with `source = 'camera'` (section 6.5a).
 *
 * The code is returned once, in the link reply, and is never logged (section 6.2b).
 */
import { randomUUID } from 'node:crypto';
import { cameraSnapshotRequestSchema, LIMITS, recordingMetaSchema, type CameraLinkReply } from '@indiansassist/shared';
import { getOrgOrThrow, listAuditBySession, type RecordingRow, type SessionRow } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, HttpError } from '../errors.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { toRecording } from '../lib/mappers.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { iso } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { assertCanUpload } from '../services/recording-service.js';
import { requireSessionAssist, scopedSession, UUID_RE } from '../services/scope.js';
import {
  cameraTierAllowed,
  countExpired,
  pushCameraLinked,
  pushCameraLinkEnded,
  stopCameraWatcher,
} from '../signal/camera.js';
import { CameraNodeLink } from './node-link.js';
import { failCameraRecording, finaliseCameraRecording, prepareCameraRecording } from './recording.js';
import {
  CAMERA_LINK_TTL_SEC,
  cameraCodeHash,
  cameraLinkKey,
  cameraLockKey,
  consumeCameraLink,
  newCameraCode,
  readCameraSession,
  clearCameraSession,
  writeCameraSession,
} from './state.js';

/** The session's Assist, on a session of the caller's org (A section 2.3: cross-org 404, out of scope 403). */
async function assistSession(ctx: AppContext, p: Principal, id: string): Promise<SessionRow> {
  const { session } = await scopedSession(ctx, p, id, { write: true });
  requireSessionAssist(p, session);
  return session;
}

function cameraIdParam(id: string): string {
  if (!UUID_RE.test(id)) fail('not_found', 'camera not found');
  return id;
}

export async function cameraRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const nodes = new CameraNodeLink(ctx);
  await nodes.start();
  const expiries = new Set<NodeJS.Timeout>();
  app.addHook('onClose', async () => {
    for (const t of expiries) clearTimeout(t);
    expiries.clear();
    stopCameraWatcher(ctx.hub);
    await nodes.stop();
  });

  /**
   * A link nobody used: just before its presence TTL runs out this node takes the code itself (so it can no longer be
   * used), and records the expiry once (`camera.ended { by: 'link_expired' }`, `ia_camera_sessions_total{expired}`).
   */
  function scheduleExpiry(s: SessionRow, cameraId: string, codeHash: string): void {
    const t = setTimeout(
      () => {
        expiries.delete(t);
        void (async () => {
          const taken = await consumeCameraLink(ctx.presence, codeHash);
          if (!taken) return;
          await clearCameraSession(ctx.presence, s.id, cameraId);
          const org = await getOrgOrThrow(ctx.db, s.orgId);
          await writeAudit(ctx, ctx.db, org, {
            sessionId: s.id,
            actor: { type: 'system', id: null, label: 'system' },
            action: 'camera.ended',
            data: { cameraId, by: 'link_expired', durationMs: null },
          });
          countExpired(ctx.hub, s.tier);
          pushCameraLinkEnded(ctx.hub, s.id, cameraId, 'link_expired');
        })().catch((err: unknown) => ctx.log.warn({ err, sessionId: s.id }, 'camera link expiry failed'));
      },
      Math.max(1, CAMERA_LINK_TTL_SEC - 1) * 1000,
    );
    t.unref?.();
    expiries.add(t);
  }

  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/camera-links', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const s = await assistSession(ctx, p, req.params.id);
    if (!cameraTierAllowed(s.tier))
      fail('camera_unsupported', 'a phone camera cannot join a browser extension session');
    if (s.state !== 'active') fail('bad_state', 'the session is not live');
    const lim = await ctx.limiter.hit(`camera-link:${p.user.id}`, 6, 60_000);
    if (!lim.allowed) {
      ctx.metrics.rateLimited.inc();
      fail('rate_limited', 'too many camera links; wait a minute', { retryAfterSec: lim.retryAfterSec });
    }
    const info = await nodes.info(s.id);
    if (!info.live) fail('bad_state', 'the session is not live on the server');
    if (info.camera) fail('camera_busy', 'this session already has a phone camera');
    if (info.unrecordable)
      fail(
        'camera_unrecordable',
        'this session is recorded by the server, and its recorder cannot record a phone camera',
      );
    // One camera per session, cluster-wide (section 6.2c); the lock covers two clicks racing between the read and write.
    if ((await ctx.presence.incr(cameraLockKey(s.id), 5)) > 1)
      fail('camera_busy', 'a camera link is being created for this session');
    try {
      if (await readCameraSession(ctx.presence, s.id))
        fail('camera_busy', 'this session already has a phone camera link');
      const cameraId = randomUUID();
      const code = newCameraCode();
      const codeHash = cameraCodeHash(code);
      const expiresAt = new Date(Date.now() + CAMERA_LINK_TTL_SEC * 1000);
      await writeCameraSession(ctx.presence, s.id, { cameraId, codeHash, state: 'linked' }, CAMERA_LINK_TTL_SEC);
      await ctx.presence.setKey(
        cameraLinkKey(codeHash),
        JSON.stringify({ cameraId, sessionId: s.id, orgId: s.orgId, region: s.region }),
        CAMERA_LINK_TTL_SEC,
      );
      await writeAudit(ctx, ctx.db, p.org, {
        sessionId: s.id,
        actor: userActor(p.user),
        action: 'camera.link_created',
        data: { cameraId, expiresAt: iso(expiresAt) },
      });
      scheduleExpiry(s, cameraId, codeHash);
      pushCameraLinked(ctx.hub, s.id, cameraId);
      const body: CameraLinkReply = {
        cameraId,
        url: `${ctx.config.webOrigin}/c/${code}`,
        code,
        expiresAt: iso(expiresAt),
      };
      return reply.status(201).header('Cache-Control', 'no-store').send(body);
    } finally {
      await ctx.presence.delKey(cameraLockKey(s.id));
    }
  });

  app.delete<{ Params: { id: string; cameraId: string } }>(
    '/api/v1/sessions/:id/camera-links/:cameraId',
    async (req, reply) => {
      const p = await authenticate(ctx, req, TECH_ROLES);
      const s = await assistSession(ctx, p, req.params.id);
      const cameraId = cameraIdParam(req.params.cameraId);
      const sess = await readCameraSession(ctx.presence, s.id);
      if (!sess || sess.cameraId !== cameraId) fail('not_found', 'camera not found');
      if (sess.state === 'linked' && (await consumeCameraLink(ctx.presence, sess.codeHash))) {
        await clearCameraSession(ctx.presence, s.id, cameraId);
        await writeAudit(ctx, ctx.db, p.org, {
          sessionId: s.id,
          actor: userActor(p.user),
          action: 'camera.link_revoked',
          data: { cameraId },
        });
        pushCameraLinkEnded(ctx.hub, s.id, cameraId, 'assist');
        return reply.status(204).send();
      }
      // Connected (or the phone took the code a moment ago): the owner node ends the camera (`camera.ended { by: assist }`).
      if (!(await nodes.end(s.id, cameraId))) {
        // A camera record whose owner no longer holds it (node restart): clear it so a new link can be made.
        await clearCameraSession(ctx.presence, s.id, cameraId);
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string; cameraId: string } }>(
    '/api/v1/sessions/:id/camera/:cameraId/snapshots',
    async (req, reply) => {
      const p = await authenticate(ctx, req, TECH_ROLES);
      const s = await assistSession(ctx, p, req.params.id);
      const cameraId = cameraIdParam(req.params.cameraId);
      const body = parseOr400(cameraSnapshotRequestSchema, req.body);
      const info = await nodes.info(s.id);
      if (!info.camera || info.camera.cameraId !== cameraId) {
        const sess = await readCameraSession(ctx.presence, s.id);
        if (!sess || sess.cameraId !== cameraId) fail('not_found', 'camera not found');
        fail('bad_state', 'the camera is not live');
      }
      if (!info.camera.started) fail('bad_state', 'the camera is not live');
      const lim = await ctx.limiter.hit(`camera-snapshot:${s.id}`, LIMITS.cameraSnapshotsPerMinute, 60_000);
      if (!lim.allowed) {
        ctx.metrics.rateLimited.inc();
        fail('rate_limited', 'too many snapshots; wait a minute', { retryAfterSec: lim.retryAfterSec });
      }
      await writeAudit(ctx, ctx.db, p.org, {
        sessionId: s.id,
        actor: userActor(p.user),
        action: 'camera.snapshot',
        data: { cameraId, sha256: body.sha256, width: body.width, height: body.height },
      });
      return reply.status(201).send({ cameraId, sha256: body.sha256, width: body.width, height: body.height });
    },
  );

  app.post<{ Params: { id: string; cameraId: string } }>(
    '/api/v1/sessions/:id/camera/:cameraId/recordings',
    async (req, reply) => {
      const p = await authenticate(ctx, req, TECH_ROLES);
      const s = await assistSession(ctx, p, req.params.id);
      const cameraId = cameraIdParam(req.params.cameraId);
      await assertCanUpload(ctx, s, p.user.id, 0);
      const linked = (await listAuditBySession(ctx.db, s.id)).some(
        (e) => e.action === 'camera.link_created' && (e.data as { cameraId?: unknown } | null)?.cameraId === cameraId,
      );
      if (!linked) fail('not_found', 'camera not found');
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
        const rec = await prepareCameraRecording(ctx, s, cameraId, 'assist', p.user.id, meta);
        let result: { bytes: number; sha256: string };
        try {
          result = await ctx.storage.put(rec.storageKey, part.file, { contentType: 'video/webm' });
          if (part.file.truncated) throw new HttpError('payload_too_large', 'recording exceeds 100 MiB');
          if (result.bytes === 0) throw new HttpError('validation_failed', 'the recording is empty');
        } catch (err) {
          await ctx.storage.delete(rec.storageKey).catch(() => undefined);
          const empty = err instanceof HttpError && err.code === 'validation_failed';
          const tooLarge =
            (err instanceof HttpError && err.code === 'payload_too_large') ||
            (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE' ||
            part.file.truncated;
          await failCameraRecording(
            ctx,
            p.org,
            rec,
            empty ? 'empty' : tooLarge ? 'payload_too_large' : 'storage_error',
            userActor(p.user),
          );
          if (empty) fail('validation_failed', 'the recording is empty');
          if (tooLarge) fail('payload_too_large', 'recording exceeds 100 MiB');
          throw err;
        }
        stored = await finaliseCameraRecording(ctx, p.org, rec, userActor(p.user), result);
      }
      if (!stored) fail('validation_failed', 'missing file field');
      return reply.status(201).send(toRecording(stored));
    },
  );
}
