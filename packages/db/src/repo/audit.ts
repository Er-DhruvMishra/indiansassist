/**
 * audit_entry writer and readers (contracts sections 4.2, 4.3, 5). `insertAuditEntry` (alias `appendAudit`) is
 * the only write path: data is validated and sanitised with the shared per-action zod schema BEFORE hashing, then in
 * one transaction it takes `pg_advisory_xact_lock(hashtext(org_id::text))`, reads the org tail, computes seq /
 * prev_hash / hash with @indiansassist/shared and inserts. Concurrent appends for one org are therefore serialised.
 *
 * LOCK ORDER (binding for every transaction in every package, contracts section 4.2; correctness-F1):
 *   1. the session row   (lockSession, or the UPDATE of transitionSession / updateSession). Its child rows
 *                        (session_participant, session_file) are touched only while holding it: a transaction that
 *                        writes children before transitioning the session calls lockSession first
 *   2. token rows        (lockToken, listActiveTokensByCreator({ forUpdate }), incrementTokenDenied, markTokenUsed)
 *   3. the org advisory lock `pg_advisory_xact_lock(hashtext(org_id))` (taken only here)
 * insertAuditEntry enforces step 1 itself when `sessionId` is set, so callers that already touched the session row
 * and callers that did not both acquire the locks in this order. A transaction must not lock an existing session or
 * token row after it has appended an entry (rows it inserted itself are exempt). test/lock-order.test.ts guards it.
 */
import {
  appendEntry,
  auditDataSchema,
  sanitiseActorLabel,
  sanitiseReason,
  type ActorType,
  type AuditAction,
  type ChainEntry,
  type JsonObject,
  type Region,
} from '@indiansassist/shared';
import { and, asc, desc, eq, gt, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { AuditRegionMismatchError, NotFoundError } from '../errors.js';
import { auditEntry, org, session, type AuditEntryRow } from '../schema/index.js';
import { clampLimit, seqBefore, seqCursorOf, toPage, type Page, type PageQuery } from './page.js';

export type AuditInput = {
  orgId: string;
  sessionId?: string | null;
  actor: { type: ActorType; id: string | null; label: string };
  action: AuditAction;
  reason?: string | null;
  /** Must equal org.data_region, else AuditRegionMismatchError. */
  region: Region;
  /** Validated with auditDataSchema(action) before hashing; ZodError on failure. Default {}. */
  data?: unknown;
  /** Default now; truncated to whole milliseconds. */
  ts?: Date;
};

/** Row -> nested hashed shape + hash (section 5.4); `ts` rebuilt with `toISOString()`, never from Postgres text. */
export function toChainEntry(row: AuditEntryRow): ChainEntry {
  return {
    id: row.id,
    action: row.action,
    actor: { id: row.actorId ?? null, label: row.actorLabel, type: row.actorType },
    data: row.data,
    org_id: row.orgId,
    prev_hash: row.prevHash,
    reason: row.reason ?? null,
    region: row.region,
    seq: row.seq,
    session_id: row.sessionId ?? null,
    ts: new Date(row.ts).toISOString(),
    hash: row.hash,
  };
}

export async function insertAuditEntry(exec: Executor, input: AuditInput): Promise<AuditEntryRow> {
  // Validation and sanitation happen before any lock is taken (throws ZodError).
  const data = auditDataSchema(input.action).parse(input.data ?? {}) as JsonObject;
  const reason = sanitiseReason(input.reason);
  const label = sanitiseActorLabel(input.actor.label);
  const ts = new Date(Math.trunc((input.ts ?? new Date()).getTime()));
  if (Number.isNaN(ts.getTime())) throw new Error('invalid audit ts');
  const sessionId = input.sessionId ?? null;

  return exec.transaction(async (tx) => {
    // Lock order (binding for every caller): row locks (session, then token) BEFORE the org advisory lock. Callers
    // that already updated the session row hold this lock; callers that did not take it here, so an audit append
    // and a session transition on the same session can never wait on each other in opposite orders (40P01).
    if (sessionId) await tx.execute(sql`select id from ${session} where ${session.id} = ${sessionId} for update`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.orgId}::text))`);
    const [o] = await tx.select({ dataRegion: org.dataRegion }).from(org).where(eq(org.id, input.orgId)).limit(1);
    if (!o) throw new NotFoundError('org', input.orgId);
    if (o.dataRegion !== input.region) throw new AuditRegionMismatchError(o.dataRegion, input.region);
    const [tail] = await tx
      .select({ seq: auditEntry.seq, hash: auditEntry.hash })
      .from(auditEntry)
      .where(eq(auditEntry.orgId, input.orgId))
      .orderBy(desc(auditEntry.seq))
      .limit(1);
    const entry = appendEntry(tail ?? null, {
      action: input.action,
      actor: { id: input.actor.id ?? null, label, type: input.actor.type },
      data,
      org_id: input.orgId,
      reason,
      region: input.region,
      session_id: sessionId,
      ts: ts.toISOString(),
    });
    const [row] = await tx
      .insert(auditEntry)
      .values({
        orgId: input.orgId,
        seq: entry.seq,
        sessionId,
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        actorLabel: entry.actor.label,
        action: entry.action,
        reason: entry.reason,
        region: entry.region,
        ts,
        data: entry.data,
        prevHash: entry.prev_hash,
        hash: entry.hash,
      })
      .returning();
    if (sessionId) await tx.update(session).set({ hashChainTail: entry.hash }).where(eq(session.id, sessionId));
    return row!;
  });
}

/** Alias of insertAuditEntry (task vocabulary). Works on a Db (own transaction) or inside a Tx (savepoint). */
export const appendAudit = insertAuditEntry;

export async function getOrgChainTail(exec: Executor, orgId: string): Promise<{ seq: number; hash: string } | null> {
  const [tail] = await exec
    .select({ seq: auditEntry.seq, hash: auditEntry.hash })
    .from(auditEntry)
    .where(eq(auditEntry.orgId, orgId))
    .orderBy(desc(auditEntry.seq))
    .limit(1);
  return tail ?? null;
}

export async function getAuditEntryBySeq(exec: Executor, orgId: string, seq: number): Promise<AuditEntryRow | null> {
  const [row] = await exec
    .select()
    .from(auditEntry)
    .where(and(eq(auditEntry.orgId, orgId), eq(auditEntry.seq, seq)))
    .limit(1);
  return row ?? null;
}

export async function getAuditEntry(exec: Executor, id: string): Promise<AuditEntryRow | null> {
  const [row] = await exec.select().from(auditEntry).where(eq(auditEntry.id, id)).limit(1);
  return row ?? null;
}

/** Every entry of a session, seq ascending, no paging (section 6.9). */
export async function listAuditBySession(exec: Executor, sessionId: string): Promise<AuditEntryRow[]> {
  return exec.select().from(auditEntry).where(eq(auditEntry.sessionId, sessionId)).orderBy(asc(auditEntry.seq));
}

/** First entry of an action within a session (e.g. `recording.started` deduplication). */
export async function findSessionAuditByAction(
  exec: Executor,
  sessionId: string,
  action: AuditAction,
): Promise<AuditEntryRow | null> {
  const [row] = await exec
    .select()
    .from(auditEntry)
    .where(and(eq(auditEntry.sessionId, sessionId), eq(auditEntry.action, action)))
    .orderBy(asc(auditEntry.seq))
    .limit(1);
  return row ?? null;
}

export type ListAuditQuery = PageQuery & {
  action?: string;
  sessionId?: string;
  /** Half-open `[from, to)` on `ts`. */
  from?: Date;
  to?: Date;
};

/** Org audit list, seq descending, cursor `<seq>` (section 6.9). */
export async function listAuditByOrgPaginated(
  exec: Executor,
  orgId: string,
  q: ListAuditQuery = {},
): Promise<Page<AuditEntryRow>> {
  const limit = clampLimit(q.limit);
  const conds: SQL[] = [eq(auditEntry.orgId, orgId)];
  if (q.action) conds.push(eq(auditEntry.action, q.action));
  if (q.sessionId) conds.push(eq(auditEntry.sessionId, q.sessionId));
  if (q.from) conds.push(gte(auditEntry.ts, q.from));
  if (q.to) conds.push(lt(auditEntry.ts, q.to));
  const before = seqBefore(auditEntry.seq, q.cursor);
  if (before) conds.push(before);
  const rows = await exec
    .select()
    .from(auditEntry)
    .where(and(...conds))
    .orderBy(desc(auditEntry.seq))
    .limit(limit + 1);
  return toPage(rows, limit, seqCursorOf);
}

/**
 * Streams an org's entries in seq order, in batches (export, verify). Optional seq bounds are inclusive and
 * the ts bounds half-open `[from, to)`.
 */
export async function* iterateOrgAudit(
  exec: Executor,
  orgId: string,
  opts: { fromSeq?: number; toSeq?: number; from?: Date; to?: Date; batchSize?: number } = {},
): AsyncGenerator<AuditEntryRow[]> {
  const batchSize = Math.max(1, opts.batchSize ?? 1000);
  let after = (opts.fromSeq ?? 1) - 1;
  for (;;) {
    const conds: SQL[] = [eq(auditEntry.orgId, orgId), gt(auditEntry.seq, after)];
    if (opts.toSeq !== undefined) conds.push(lte(auditEntry.seq, opts.toSeq));
    if (opts.from) conds.push(gte(auditEntry.ts, opts.from));
    if (opts.to) conds.push(lt(auditEntry.ts, opts.to));
    const rows = await exec
      .select()
      .from(auditEntry)
      .where(and(...conds))
      .orderBy(asc(auditEntry.seq))
      .limit(batchSize);
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1]!.seq;
    if (rows.length < batchSize) return;
  }
}

export async function countOrgAudit(exec: Executor, orgId: string): Promise<number> {
  const [row] = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEntry)
    .where(eq(auditEntry.orgId, orgId));
  return row?.n ?? 0;
}
