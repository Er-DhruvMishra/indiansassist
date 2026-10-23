/**
 * Audit routes (contracts sections 5.4-5.6, 6.9): session audit with server-side integrity, org list, JSONL export
 * (header line, `kind = export` checkpoint before the body streams) and chain verification with a persisted
 * `kind = verify` checkpoint.
 */
import { Readable } from 'node:stream';
import {
  auditExportRequestSchema,
  auditListQuerySchema,
  canonicalJson,
  GENESIS_HASH,
  type AuditExportHeader,
} from '@indiansassist/shared';
import {
  auditEntry,
  getAuditEntryBySeq,
  getLatestCheckpoint,
  getOrgChainTail,
  iterateOrgAudit,
  listAuditByOrgPaginated,
  listAuditBySession,
  listSessionFiles,
  sessionHostMap,
  toChainEntry,
  verifyOrgChain,
} from '@indiansassist/db';
import { and, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { userActor, writeAudit } from '../lib/audit.js';
import { exportKeys } from '../lib/keys.js';
import { toAuditEntry, toSessionFile } from '../lib/mappers.js';
import { yyyymmdd } from '../lib/time.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';
import { sessionIntegrity, verifyResultOf, writeCheckpoint } from '../services/audit-service.js';
import { scopedSession } from '../services/scope.js';

export async function auditRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/v1/sessions/:id/audit', async (req) => {
    const p = await authenticate(ctx, req);
    const { session } = await scopedSession(ctx, p, req.params.id);
    const rows = await listAuditBySession(ctx.db, session.id);
    const integrity = await sessionIntegrity(ctx.db, p.org.id, rows);
    return {
      items: rows.map(toAuditEntry),
      integrity: { ...integrity, verifiedAt: new Date().toISOString() },
      files: (await listSessionFiles(ctx.db, session.id)).map(toSessionFile),
      // Phase B 11.3: plaintext hosts behind `hostHash` (same visibility as file names).
      hosts: await sessionHostMap(ctx.db, session.id),
    };
  });

  app.get('/api/v1/audit', async (req) => {
    const p = await authenticate(ctx, req, ['senior_technician', 'org_admin', 'auditor']);
    const q = parseOr400(auditListQuerySchema, req.query);
    const page = await listAuditByOrgPaginated(ctx.db, p.org.id, {
      limit: q.limit,
      cursor: q.cursor ?? null,
      ...(q.action ? { action: q.action } : {}),
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
    });
    return { items: page.items.map(toAuditEntry), nextCursor: page.nextCursor };
  });

  app.post('/api/v1/audit/export', async (req, reply) => {
    const p = await authenticate(ctx, req, ['org_admin', 'auditor']);
    const body = parseOr400(auditExportRequestSchema, req.body ?? {});
    const from = body.from ? new Date(body.from) : undefined;
    const to = body.to ? new Date(body.to) : undefined;
    // Anchor the chain before the body streams (section 6.9), then fix the exported range.
    await writeCheckpoint(ctx, ctx.db, p.org, 'export');
    const tail = await getOrgChainTail(ctx.db, p.org.id);
    const toSeq = tail?.seq ?? 0;
    const conds: SQL[] = [eq(auditEntry.orgId, p.org.id), lte(auditEntry.seq, toSeq)];
    if (from) conds.push(gte(auditEntry.ts, from));
    if (to) conds.push(lt(auditEntry.ts, to));
    const [range] = await ctx.db
      .select({
        n: sql<number>`count(*)::int`,
        min: sql<number | null>`min(${auditEntry.seq})`,
        max: sql<number | null>`max(${auditEntry.seq})`,
      })
      .from(auditEntry)
      .where(and(...conds));
    const count = Number(range?.n ?? 0);
    const minSeq = range?.min !== null && range?.min !== undefined ? Number(range.min) : null;
    const maxSeq = range?.max !== null && range?.max !== undefined ? Number(range.max) : null;
    const first = minSeq !== null ? await getAuditEntryBySeq(ctx.db, p.org.id, minSeq) : null;
    const exportedAt = new Date();
    const header: AuditExportHeader = {
      ia_audit_export: 1,
      orgId: p.org.id,
      orgSlug: p.org.slug,
      region: p.org.dataRegion,
      exportedAt: exportedAt.toISOString(),
      startSeq: first?.seq ?? 1,
      startPrevHash: first?.prevHash ?? GENESIS_HASH,
      count,
      keys: exportKeys(ctx.keys),
    };
    await writeAudit(ctx, ctx.db, p.org, {
      actor: userActor(p.user),
      action: 'audit.exported',
      data: { format: 'jsonl', count, fromSeq: minSeq, toSeq: maxSeq },
    });
    const orgId = p.org.id;
    async function* lines(): AsyncGenerator<string> {
      yield canonicalJson(header) + '\n';
      if (minSeq === null || maxSeq === null) return;
      const opts = { fromSeq: minSeq, toSeq: maxSeq, ...(from ? { from } : {}), ...(to ? { to } : {}) };
      for await (const batch of iterateOrgAudit(ctx.db, orgId, opts)) {
        yield batch.map((r) => canonicalJson(toChainEntry(r)) + '\n').join('');
      }
    }
    void reply
      .header('Content-Type', 'application/x-ndjson; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-${p.org.slug}-${yyyymmdd(exportedAt)}.jsonl"`);
    return reply.send(Readable.from(lines()));
  });

  app.post('/api/v1/audit/verify', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin', 'auditor']);
    const result = await verifyOrgChain(ctx.db, p.org.id, { pubKeys: ctx.keys.all });
    const verify = { ok: result.ok, checked: result.checked, ...(result.failure ? { failure: result.failure } : {}) };
    const cp = await writeCheckpoint(ctx, ctx.db, p.org, 'verify', verify);
    await writeAudit(ctx, ctx.db, p.org, {
      actor: userActor(p.user),
      action: 'audit.verified',
      data: { ok: result.ok, checked: result.checked, failure: result.failure ?? null },
    });
    return {
      ok: result.ok,
      checked: result.checked,
      tail: result.tail,
      ...(result.failure ? { failure: result.failure } : {}),
      verifiedAt: cp ? new Date(cp.ts).toISOString() : new Date().toISOString(),
    };
  });

  app.get('/api/v1/audit/verify', async (req) => {
    const p = await authenticate(ctx, req, ['org_admin', 'auditor']);
    const cp = await getLatestCheckpoint(ctx.db, p.org.id, 'verify');
    return cp ? verifyResultOf(cp) : null;
  });
}
