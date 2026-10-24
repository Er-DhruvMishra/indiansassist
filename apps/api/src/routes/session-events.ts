/**
 * `POST /api/v1/sessions/:id/events` (contracts section 6.8; Phase B 3.6, 3.7, Y24): the Assist console's own
 * reports. `file.*` attestations (once per transfer), deduplicated `recording.started`, and the P2 control-op
 * reports (`tab.action`, `control.input`, `mask.requested`, `level.requested`, `backstage.*`, actor `user`) with
 * the wire `host` mapped to `hostHash`; the P2 reports are rate limited per session (10 / s, burst 30).
 */
import {
  ASSIST_EVENT_REASON_ACTIONS,
  hostToHash,
  LIMITS,
  sanitiseFileName,
  sessionEventRequestSchema,
} from '@indiansassist/shared';
import {
  findSessionAuditByAction,
  getAuditEntry,
  listSessionFiles,
  markRecordingStarted,
  upsertSessionFile,
  upsertSessionHost,
  type SessionRow,
} from '@indiansassist/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { piiHash, userActor, writeAudit } from '../lib/audit.js';
import { toAuditEntry } from '../lib/mappers.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { parseOr400 } from '../lib/validate.js';
import { TokenBucket } from '../limiter.js';
import { authenticate, type Principal } from '../plugins/auth.js';
import { requireAssistMayRecord, requireReachedActive, requireSessionAssist, scopedSession } from '../services/scope.js';
import { MAX_ATTESTED_FILE_ID } from '../signal/desk-events.js';

type Body = ReturnType<typeof sessionEventRequestSchema.parse>;

/** Per-session buckets for the console reports (bounded; the oldest is evicted). */
const buckets = new Map<string, TokenBucket>();
const MAX_BUCKETS = 10_000;

function takeReport(sessionId: string): boolean {
  let b = buckets.get(sessionId);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
    b = new TokenBucket(LIMITS.assistEventsPerSec, LIMITS.assistEventsBurst);
    buckets.set(sessionId, b);
  }
  return b.take();
}

export async function sessionEventRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/events', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    requireSessionAssist(p, session);
    const body = parseOr400(sessionEventRequestSchema, req.body);
    if (session.endedAt && Date.now() > session.endedAt.getTime() + LIMITS.eventGraceSec * 1000)
      fail('already_ended', 'session ended too long ago');
    if (body.action === 'recording.started') return recordingStarted(ctx, p, session, reply);
    requireReachedActive(session);
    if (body.action === 'file.sent' || body.action === 'file.received') return fileEvent(ctx, p, session, body, reply);
    return consoleReport(ctx, p, session, body, reply);
  });
}

async function recordingStarted(ctx: AppContext, p: Principal, session: SessionRow, reply: FastifyReply) {
  requireAssistMayRecord(session); // Phase A.2 section 3
  const existing = await findSessionAuditByAction(ctx.db, session.id, 'recording.started');
  if (existing) return reply.status(200).send(toAuditEntry(existing));
  const entry = await ctx.db.transaction(async (tx) => {
    if (!(await markRecordingStarted(tx, session.id))) return null;
    return writeAudit(ctx, tx, p.org, { sessionId: session.id, actor: userActor(p.user), action: 'recording.started' });
  });
  if (!entry) {
    const again = await findSessionAuditByAction(ctx.db, session.id, 'recording.started');
    if (again) return reply.status(200).send(toAuditEntry(again));
    fail('already_ended', 'recording state changed');
  }
  await ctx.hub.pushRecording(session.id);
  return reply.status(201).send(toAuditEntry(entry));
}

/** File attestations (SEC-04): only for a session that reached active, once per transfer, bounded fileId. */
async function fileEvent(ctx: AppContext, p: Principal, session: SessionRow, body: Body, reply: FastifyReply) {
  if (body.action !== 'file.sent' && body.action !== 'file.received') throw new Error('unreachable');
  const d = body.data;
  if (d.fileId > MAX_ATTESTED_FILE_ID) fail('validation_failed', `fileId must be at most ${MAX_ATTESTED_FILE_ID}`);
  const already = (await listSessionFiles(ctx.db, session.id)).find(
    (f) => f.direction === d.direction && f.fileId === d.fileId && f.assistEntryId,
  );
  if (already?.assistEntryId) {
    const prior = await getAuditEntry(ctx.db, already.assistEntryId);
    if (prior) return reply.status(200).send(toAuditEntry(prior));
  }
  const name = sanitiseFileName(d.name, d.fileId);
  const entry = await ctx.db.transaction(async (tx) => {
    const e = await writeAudit(ctx, tx, p.org, {
      sessionId: session.id,
      actor: userActor(p.user),
      action: body.action,
      data: { fileId: d.fileId, direction: d.direction, nameHash: piiHash(p.org, name), bytes: d.bytes, sha256: d.sha256 },
    });
    await upsertSessionFile(tx, {
      sessionId: session.id,
      direction: d.direction,
      fileId: d.fileId,
      name,
      bytes: d.bytes,
      sha256: d.sha256,
      side: 'assist',
      entryId: e.id,
    });
    return e;
  });
  return reply.status(201).send(toAuditEntry(entry));
}

/** The console's half of the dual attestation (Phase B 3.7): P2 sessions only, while active and for 60 s after. */
async function consoleReport(ctx: AppContext, p: Principal, session: SessionRow, body: Body, reply: FastifyReply) {
  if (session.tier !== 'p2_extension') fail('validation_failed', `${body.action} is reported in P2 sessions only`);
  if (session.state !== 'active' && session.state !== 'ended') fail('forbidden', `session is ${session.state}`);
  if (!ctx.config.rateLimitDisabled && !takeReport(session.id)) {
    ctx.metrics.rateLimited.inc();
    fail('rate_limited', 'too many reports for this session', { retryAfterSec: 1 });
  }
  const { data, host } = hostToHash(body.data as Record<string, unknown>, (h) => piiHash(p.org, h));
  const withReason = (ASSIST_EVENT_REASON_ACTIONS as readonly string[]).includes(body.action);
  const reason = withReason ? ((body as { reason?: string }).reason ?? null) : null;
  const entry = await ctx.db.transaction(async (tx) => {
    const e = await writeAudit(ctx, tx, p.org, {
      sessionId: session.id,
      actor: userActor(p.user),
      action: body.action as Exclude<Body['action'], 'file.sent' | 'file.received' | 'recording.started'>,
      reason,
      data,
    });
    if (host !== null)
      await upsertSessionHost(tx, { sessionId: session.id, orgId: session.orgId, hostHash: data.hostHash!, host });
    return e;
  });
  return reply.status(201).send(toAuditEntry(entry));
}
