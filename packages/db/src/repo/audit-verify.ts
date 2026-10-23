/**
 * Org chain verification over the database (section 5.4) and signed checkpoints (section 5.6). Rows are streamed
 * in batches and each batch is checked with shared `verifyChain`, continuing from the previous batch's tail; an
 * `audit.anchored` entry that references an entry of an earlier batch is checked against that entry here.
 */
import {
  verifyChain,
  type ChainEntry,
  type CheckpointKind,
  type PublicKeyLike,
  type VerifyFailure,
  type VerifyResult,
} from '@indiansassist/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { NotFoundError } from '../errors.js';
import { auditCheckpoint, org, type AuditCheckpointRow } from '../schema/index.js';
import { getAuditEntryBySeq, iterateOrgAudit, toChainEntry } from './audit.js';

export type VerifyOrgChainOptions = {
  /** Public keys for `audit.anchored` signature checks; anchors are not signature-checked without them. */
  pubKeys?: readonly PublicKeyLike[];
  /** `undefined` loads the org's latest checkpoint; `null` verifies without one. */
  checkpoint?: { seq: number; tail: string } | null;
  batchSize?: number;
};

function anchorRef(e: ChainEntry): { seq: number; tail: string } | null {
  if (e.action !== 'audit.anchored') return null;
  const { seq, tail } = e.data as { seq?: unknown; tail?: unknown };
  return typeof seq === 'number' && typeof tail === 'string' ? { seq, tail } : null;
}

export async function verifyOrgChain(
  exec: Executor,
  orgId: string,
  opts: VerifyOrgChainOptions = {},
): Promise<VerifyResult> {
  const [o] = await exec.select({ dataRegion: org.dataRegion }).from(org).where(eq(org.id, orgId)).limit(1);
  if (!o) throw new NotFoundError('org', orgId);
  const cp =
    opts.checkpoint === undefined
      ? await getLatestCheckpoint(exec, orgId).then((c) => (c ? { seq: c.seq, tail: c.tail } : null))
      : opts.checkpoint;

  let checked = 0;
  let tail: string | null = null;
  let lastSeq = 0;
  let prevBatch = new Map<number, string>();

  for await (const rows of iterateOrgAudit(exec, orgId, { batchSize: opts.batchSize ?? 1000 })) {
    const entries = rows.map(toChainEntry);
    const first = entries[0]!.seq;
    const last = entries[entries.length - 1]!.seq;
    const res = verifyChain(entries, {
      orgId,
      region: o.dataRegion,
      ...(tail !== null ? { start: { seq: lastSeq + 1, prevHash: tail } } : {}),
      ...(opts.pubKeys ? { pubKeys: opts.pubKeys } : {}),
      ...(cp && cp.seq >= first && cp.seq <= last ? { checkpoint: cp } : {}),
    });
    const failAt = res.ok ? Number.POSITIVE_INFINITY : res.failure!.seq;

    // Anchors pointing into an earlier batch (verifyChain only sees the current batch).
    if (opts.pubKeys) {
      for (const e of entries) {
        if (e.seq >= failAt) break;
        const ref = anchorRef(e);
        if (!ref || ref.seq >= first) continue;
        const known = prevBatch.get(ref.seq) ?? (await getAuditEntryBySeq(exec, orgId, ref.seq))?.hash;
        if (known !== undefined && known !== ref.tail) {
          const idx = e.seq - first;
          return {
            ok: false,
            checked: checked + idx,
            tail: idx > 0 ? entries[idx - 1]!.hash : tail,
            failure: { kind: 'anchor_mismatch', seq: e.seq },
          };
        }
      }
    }
    if (!res.ok) return { ok: false, checked: checked + res.checked, tail: res.tail, failure: res.failure! };
    checked += res.checked;
    tail = res.tail;
    lastSeq = last;
    prevBatch = new Map(entries.map((e) => [e.seq, e.hash]));
  }

  if (cp && lastSeq < cp.seq) return { ok: false, checked, tail, failure: { kind: 'tail_regression', seq: lastSeq } };
  return { ok: true, checked, tail };
}

// ---------- checkpoints (5.6) ----------

export type InsertCheckpointInput = {
  orgId: string;
  kind: CheckpointKind;
  seq: number;
  tail: string;
  ts: Date;
  kid: string;
  sig: string;
  verify?: { ok: boolean; checked: number; failure?: VerifyFailure };
  anchoredEntryId?: string | null;
};

export async function insertAuditCheckpoint(exec: Executor, input: InsertCheckpointInput): Promise<AuditCheckpointRow> {
  const [row] = await exec
    .insert(auditCheckpoint)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      seq: input.seq,
      tail: input.tail,
      ts: new Date(Math.trunc(input.ts.getTime())),
      kid: input.kid,
      sig: input.sig,
      anchoredEntryId: input.anchoredEntryId ?? null,
      verifyOk: input.verify ? input.verify.ok : null,
      verifyChecked: input.verify ? input.verify.checked : null,
      verifyFailure: input.verify?.failure ?? null,
    })
    .returning();
  return row!;
}

/** Links a checkpoint to its `audit.anchored` entry; the trigger permits this one update, once, from NULL. */
export async function setCheckpointAnchor(
  exec: Executor,
  checkpointId: string,
  entryId: string,
): Promise<AuditCheckpointRow> {
  const [row] = await exec
    .update(auditCheckpoint)
    .set({ anchoredEntryId: entryId })
    .where(eq(auditCheckpoint.id, checkpointId))
    .returning();
  if (!row) throw new NotFoundError('audit_checkpoint', checkpointId);
  return row;
}

/** Latest checkpoint of an org (highest seq, then newest), optionally of one kind. */
export async function getLatestCheckpoint(
  exec: Executor,
  orgId: string,
  kind?: CheckpointKind,
): Promise<AuditCheckpointRow | null> {
  const where = kind
    ? and(eq(auditCheckpoint.orgId, orgId), eq(auditCheckpoint.kind, kind))
    : eq(auditCheckpoint.orgId, orgId);
  const orderBy = kind
    ? [desc(auditCheckpoint.createdAt), desc(auditCheckpoint.seq)]
    : [desc(auditCheckpoint.seq), desc(auditCheckpoint.createdAt)];
  const [row] = await exec
    .select()
    .from(auditCheckpoint)
    .where(where)
    .orderBy(...orderBy)
    .limit(1);
  return row ?? null;
}
