/**
 * Signed checkpoints (contracts section 5.6) and the session integrity check of section 6.9.
 * A checkpoint signs `{ org_id, seq, tail, ts }` with the node's token key, is stored in `audit_checkpoint`, and is
 * followed immediately by an `audit.anchored` entry that the checkpoint row then points at.
 */
import {
  GENESIS_HASH,
  hashAuditEntry,
  signCheckpoint,
  type CheckpointKind,
  type VerifyFailure,
} from '@indiansassist/shared';
import {
  getAuditEntryBySeq,
  getOrgChainTail,
  insertAuditCheckpoint,
  setCheckpointAnchor,
  toChainEntry,
  type AuditCheckpointRow,
  type AuditEntryRow,
  type Executor,
  type OrgRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { systemActor, writeAudit } from '../lib/audit.js';

/** Writes a checkpoint of the org's current tail plus its `audit.anchored` entry; null for an empty chain. */
export async function writeCheckpoint(
  ctx: AppContext,
  exec: Executor,
  org: OrgRow,
  kind: CheckpointKind,
  verify?: { ok: boolean; checked: number; failure?: VerifyFailure },
): Promise<AuditCheckpointRow | null> {
  return exec.transaction(async (tx) => {
    const tail = await getOrgChainTail(tx, org.id);
    if (!tail) return null;
    const ts = new Date(Math.trunc(Date.now()));
    const tsIso = ts.toISOString();
    const sig = await signCheckpoint({ org_id: org.id, seq: tail.seq, tail: tail.hash, ts: tsIso }, ctx.keys.seedHex);
    const cp = await insertAuditCheckpoint(tx, {
      orgId: org.id,
      kind,
      seq: tail.seq,
      tail: tail.hash,
      ts,
      kid: ctx.keys.kid,
      sig,
      ...(verify ? { verify } : {}),
    });
    const entry = await writeAudit(ctx, tx, org, {
      actor: systemActor,
      action: 'audit.anchored',
      ts,
      data: { seq: tail.seq, tail: tail.hash, ts: tsIso, kid: ctx.keys.kid, sig },
    });
    const linked = await setCheckpointAnchor(tx, cp.id, entry.id);
    ctx.log.info({ orgId: org.id, seq: tail.seq, tail: tail.hash, kid: ctx.keys.kid, kind }, 'audit_checkpoint');
    return linked;
  });
}

/**
 * Section 6.9 integrity of a session's (non-contiguous) entries: each entry's hash is recomputed and its prev_hash
 * compared with the hash of its actual predecessor `seq - 1` in the org chain.
 */
export async function sessionIntegrity(
  exec: Executor,
  orgId: string,
  entries: AuditEntryRow[],
): Promise<{ ok: boolean; checked: number; failure?: VerifyFailure }> {
  let checked = 0;
  for (const row of entries) {
    let computed: string;
    try {
      computed = hashAuditEntry(toChainEntry(row));
    } catch {
      computed = '';
    }
    if (computed !== row.hash) return { ok: false, checked, failure: { kind: 'hash_mismatch', seq: row.seq } };
    const prev = row.seq === 1 ? GENESIS_HASH : (await getAuditEntryBySeq(exec, orgId, row.seq - 1))?.hash;
    if (prev !== row.prevHash) return { ok: false, checked, failure: { kind: 'prev_mismatch', seq: row.seq } };
    checked += 1;
  }
  return { ok: true, checked };
}

/** GET /audit/verify and residency: the latest `kind = verify` checkpoint as a verify result. */
export function verifyResultOf(cp: AuditCheckpointRow): {
  ok: boolean;
  checked: number;
  tail: string | null;
  failure?: VerifyFailure;
  verifiedAt: string;
} {
  return {
    ok: cp.verifyOk ?? false,
    checked: cp.verifyChecked ?? 0,
    tail: cp.tail,
    ...(cp.verifyFailure ? { failure: cp.verifyFailure } : {}),
    verifiedAt: new Date(cp.ts).toISOString(),
  };
}
