/**
 * Session routes (contracts section 6.8): list, stats, detail with participants and file attestations, end (pushes
 * `session.ended` over WS) and the Assist's client-reported events (`file.*`, deduplicated `recording.started`).
 */
import {
  LIMITS,
  sanitiseFileName,
  SESSION_END_REASONS,
  sessionEndRequestSchema,
  sessionEventRequestSchema,
  sessionsListQuerySchema,
  sessionStatsQuerySchema,
  type SessionEndReason,
  type SessionStatsResponse,
} from '@indiansassist/shared';
import {
  findSessionAuditByAction,
  listParticipants,
  listSessionFiles,
  listSessionsByOrg,
  getAuditEntry,
  markRecordingStarted,
  session as sessionTable,
  token as tokenTable,
  upsertSessionFile,
} from '@indiansassist/db';
import { and, eq, gte, inArray, lt, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { piiHash, userActor, writeAudit } from '../lib/audit.js';
import { hydrateSession, hydrateSessions } from '../lib/lookup.js';
import { toAuditEntry, toSessionFile } from '../lib/mappers.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { iso, isoOrNull } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';
import { requireReachedActive, requireSessionAssist, scopedSession } from '../services/scope.js';
import { MAX_ATTESTED_FILE_ID } from '../signal/desk-events.js';
import { endSessionFlow } from '../services/session-end.js';

const DAY_MS = 86_400_000;

export async function sessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/sessions', async (req) => {
    const p = await authenticate(ctx, req);
    const q = parseOr400(sessionsListQuerySchema, req.query);
    const page = await listSessionsByOrg(ctx.db, p.org.id, {
      limit: q.limit,
      cursor: q.cursor ?? null,
      ...(q.state ? { state: q.state } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
      ...(p.user.role === 'technician' ? { ownUserId: p.user.id } : {}),
    });
    return { items: await hydrateSessions(ctx.db, page.items), nextCursor: page.nextCursor };
  });

  app.get('/api/v1/sessions/stats', async (req): Promise<SessionStatsResponse> => {
    const p = await authenticate(ctx, req);
    const q = parseOr400(sessionStatsQuerySchema, req.query);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
    const conds: SQL[] = [eq(sessionTable.orgId, p.org.id), gte(sessionTable.knockedAt, from), lt(sessionTable.knockedAt, to)];
    if (p.user.role === 'technician') {
      const own = ctx.db.select({ id: tokenTable.id }).from(tokenTable).where(eq(tokenTable.createdBy, p.user.id));
      conds.push(or(eq(sessionTable.assistUserId, p.user.id), inArray(sessionTable.tokenId, own))!);
    }
    const rows = await ctx.db.select().from(sessionTable).where(and(...conds));
    const byEndReason = Object.fromEntries(SESSION_END_REASONS.map((r) => [r, 0])) as Record<SessionEndReason, number>;
    const byPath = { p2p: 0, relay: 0, unknown: 0 };
    const byDay = new Map<string, number>();
    const durations: number[] = [];
    const rtts: number[] = [];
    let active = 0;
    for (const s of rows) {
      if (s.state === 'active') active++;
      byPath[s.path]++;
      if (s.endReason) byEndReason[s.endReason]++;
      if (s.startedAt && s.endedAt) durations.push(s.endedAt.getTime() - s.startedAt.getTime());
      const rtt = (s.lastStats as { rttMs?: unknown } | null)?.rttMs;
      if (typeof rtt === 'number' && Number.isFinite(rtt)) rtts.push(rtt);
      const day = s.knockedAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    rtts.sort((a, b) => a - b);
    const mid = Math.floor(rtts.length / 2);
    const median = rtts.length === 0 ? null : rtts.length % 2 ? rtts[mid]! : (rtts[mid - 1]! + rtts[mid]!) / 2;
    return {
      total: rows.length,
      active,
      byPath,
      byEndReason,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      medianRttMs: median,
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/v1/sessions/:id', async (req) => {
    const p = await authenticate(ctx, req);
    const { session } = await scopedSession(ctx, p, req.params.id, { allowObserver: true });
    const participants = (await listParticipants(ctx.db, session.id)).map((x) => ({
      role: x.role,
      label: x.label,
      userId: x.userId ?? null,
      connectionId: x.connectionId,
      joinedAt: iso(x.joinedAt),
      leftAt: isoOrNull(x.leftAt),
    }));
    const files = (await listSessionFiles(ctx.db, session.id)).map(toSessionFile);
    return { ...(await hydrateSession(ctx.db, session)), participants, files };
  });

  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/end', async (req) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    if (session.state === 'ended') fail('already_ended', 'session already ended');
    const body = parseOr400(sessionEndRequestSchema, req.body);
    const ended = await endSessionFlow(ctx, session.id, {
      reason: 'assist_ended',
      actor: userActor(p.user),
      note: body.note ?? null,
    });
    return hydrateSession(ctx.db, ended.session);
  });

  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/events', async (req, reply) => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const { session } = await scopedSession(ctx, p, req.params.id, { write: true });
    requireSessionAssist(p, session);
    const body = parseOr400(sessionEventRequestSchema, req.body);
    if (session.endedAt && Date.now() > session.endedAt.getTime() + LIMITS.eventGraceSec * 1000)
      fail('already_ended', 'session ended too long ago');
    if (body.action === 'recording.started') {
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
      ctx.hub.pushRecording(session.id);
      return reply.status(201).send(toAuditEntry(entry));
    }
    // File attestations (SEC-04): only for a session that reached active, once per transfer, bounded fileId.
    requireReachedActive(session);
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
  });
}
