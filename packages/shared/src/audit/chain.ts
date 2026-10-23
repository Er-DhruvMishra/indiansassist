/**
 * Audit hash chain (contracts sections 5.2, 5.4, 5.6): hashed material, entry hash, checkpoint signing and
 * the verify algorithm. `computeEntryHash` is an alias of `hashAuditEntry`.
 */
import { canonicalJson, canonicalJsonBytes, sha256Hex, type JsonObject } from '../canonical.js';
import { signBytes, verifyBytes, verifyBytesSync, type PublicKeyLike } from '../crypto.js';
import type { ActorType, VerifyFailureKind } from '../enums.js';
import type { Region } from '../regions.js';

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** Exactly the ten hashed keys (section 5.2); null is explicit, never omitted. */
export type AuditMaterial = {
  action: string;
  actor: { id: string | null; label: string; type: ActorType };
  data: JsonObject;
  org_id: string;
  prev_hash: string;
  reason: string | null;
  region: Region;
  seq: number;
  session_id: string | null;
  ts: string;
};

export type ChainEntry = AuditMaterial & { hash: string; id?: string };

export type VerifyFailure = { kind: VerifyFailureKind; seq: number };
export type VerifyResult = { ok: boolean; checked: number; tail: string | null; failure?: VerifyFailure };

export type VerifyOptions = {
  orgId: string;
  region?: Region;
  start?: { seq: number; prevHash: string };
  pubKeys?: readonly PublicKeyLike[];
  checkpoint?: { seq: number; tail: string };
};

/** `material(e)`: the entry without `hash` / `id` and with exactly the ten keys (extra keys are dropped). */
export function materialOf(e: AuditMaterial): AuditMaterial {
  return {
    action: e.action,
    actor: { id: e.actor.id ?? null, label: e.actor.label, type: e.actor.type },
    data: e.data,
    org_id: e.org_id,
    prev_hash: e.prev_hash,
    reason: e.reason ?? null,
    region: e.region,
    seq: e.seq,
    session_id: e.session_id ?? null,
    ts: e.ts,
  };
}

/** `sha256Hex(utf8(canonicalJson(material)))`. */
export function hashAuditEntry(material: AuditMaterial): string {
  return sha256Hex(canonicalJsonBytes(materialOf(material)));
}

/** Alias of hashAuditEntry. */
export const computeEntryHash = hashAuditEntry;

/** Builds the next entry of a chain: fills `prev_hash` and `seq` from the tail and computes `hash`. */
export function appendEntry(
  tail: { seq: number; hash: string } | null,
  fields: Omit<AuditMaterial, 'prev_hash' | 'seq'>,
): ChainEntry {
  const material: AuditMaterial = {
    ...fields,
    prev_hash: tail ? tail.hash : GENESIS_HASH,
    seq: tail ? tail.seq + 1 : 1,
  };
  return { ...materialOf(material), hash: hashAuditEntry(material) };
}

// ---------- checkpoints (5.6) ----------

export type CheckpointMaterial = { org_id: string; seq: number; tail: string; ts: string };

/** Bytes signed for a checkpoint: canonicalJson({ org_id, seq, tail, ts }). */
export function checkpointMessage(c: CheckpointMaterial): Uint8Array {
  return canonicalJsonBytes({ org_id: c.org_id, seq: c.seq, tail: c.tail, ts: c.ts });
}

export async function signCheckpoint(c: CheckpointMaterial, seedHex: string): Promise<string> {
  return signBytes(checkpointMessage(c), seedHex);
}

export async function verifyCheckpoint(
  c: CheckpointMaterial,
  sig: string,
  kid: string,
  keys: readonly PublicKeyLike[],
): Promise<boolean> {
  return verifyBytes(checkpointMessage(c), sig, kid, keys);
}

// ---------- verify (5.4) ----------

function anchorFields(data: JsonObject): { seq: number; tail: string; ts: string; kid: string; sig: string } | null {
  const { seq, tail, ts, kid, sig } = data as Record<string, unknown>;
  if (typeof seq !== 'number' || typeof tail !== 'string' || typeof ts !== 'string') return null;
  if (typeof kid !== 'string' || typeof sig !== 'string') return null;
  return { seq, tail, ts, kid, sig };
}

/**
 * Section 5.4 over the entries of one org, ordered by seq ascending. Stops at the first failure.
 * `checked` counts entries that passed every check; `tail` is the hash of the last passing entry
 * (or the start prev hash, or null for an empty chain with no start).
 */
export function verifyChain(entries: Iterable<ChainEntry>, opts: VerifyOptions): VerifyResult {
  let expectedPrev = opts.start?.prevHash ?? GENESIS_HASH;
  let expectedSeq = opts.start?.seq ?? 1;
  let checked = 0;
  let lastHash: string | null = opts.start ? opts.start.prevHash : null;
  const seen = new Map<number, string>();
  const pendingAnchors = new Map<number, { tail: string; anchorSeq: number }[]>();
  const fail = (kind: VerifyFailureKind, seq: number): VerifyResult => ({
    ok: false,
    checked,
    tail: lastHash,
    failure: { kind, seq },
  });

  for (const e of entries) {
    if (e.org_id !== opts.orgId) return fail('org_mismatch', e.seq);
    if (opts.region && e.region !== opts.region) return fail('region_mismatch', e.seq);
    if (e.seq !== expectedSeq) return fail('seq_gap', e.seq);
    if (e.prev_hash !== expectedPrev) return fail('prev_mismatch', e.seq);
    let computed: string;
    try {
      computed = hashAuditEntry(e);
    } catch {
      return fail('hash_mismatch', e.seq);
    }
    if (computed !== e.hash) return fail('hash_mismatch', e.seq);
    if (e.action === 'audit.anchored' && opts.pubKeys) {
      const a = anchorFields(e.data);
      if (!a) return fail('anchor_bad_signature', e.seq);
      const msg = checkpointMessage({ org_id: opts.orgId, seq: a.seq, tail: a.tail, ts: a.ts });
      if (!verifyBytesSync(msg, a.sig, a.kid, opts.pubKeys)) return fail('anchor_bad_signature', e.seq);
      const known = seen.get(a.seq);
      if (known !== undefined) {
        if (known !== a.tail) return fail('anchor_mismatch', e.seq);
      } else if (a.seq > e.seq) {
        const list = pendingAnchors.get(a.seq) ?? [];
        list.push({ tail: a.tail, anchorSeq: e.seq });
        pendingAnchors.set(a.seq, list);
      }
    }
    const pending = pendingAnchors.get(e.seq);
    if (pending) {
      for (const p of pending) if (p.tail !== e.hash) return fail('anchor_mismatch', p.anchorSeq);
      pendingAnchors.delete(e.seq);
    }
    if (opts.checkpoint && e.seq === opts.checkpoint.seq && e.hash !== opts.checkpoint.tail)
      return fail('tail_regression', e.seq);
    seen.set(e.seq, e.hash);
    expectedPrev = e.hash;
    lastHash = e.hash;
    expectedSeq += 1;
    checked += 1;
  }
  if (opts.checkpoint && expectedSeq - 1 < opts.checkpoint.seq) return fail('tail_regression', expectedSeq - 1);
  return { ok: true, checked, tail: lastHash };
}

/** Convenience: verifies an array (alias kept for callers that hold the whole chain in memory). */
export function verifyChainArray(entries: readonly ChainEntry[], opts: VerifyOptions): VerifyResult {
  return verifyChain(entries, opts);
}

/** canonicalJson re-export point for chain consumers that serialise material themselves. */
export function canonicalMaterial(e: AuditMaterial): string {
  return canonicalJson(materialOf(e));
}
