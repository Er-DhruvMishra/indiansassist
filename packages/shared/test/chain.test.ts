import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  appendEntry,
  buildAuditJsonl,
  computeEntryHash,
  hashAuditEntry,
  materialOf,
  parseAuditJsonl,
  publicKeyEntry,
  publicKeyFromSeed,
  publicKeyToBase64url,
  signCheckpoint,
  verifyAuditJsonl,
  verifyChain,
  verifyCheckpoint,
  type AuditMaterial,
  type ChainEntry,
} from '../src/index.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';

function fields(i: number): Omit<AuditMaterial, 'prev_hash' | 'seq'> {
  return {
    action: i % 2 === 0 ? 'session.started' : 'token.created',
    actor: { id: i % 3 === 0 ? null : `actor-${i}`, label: `Actor ${i}`, type: 'user' },
    data: { n: i, nested: { list: [i, 'x', true, null] } },
    org_id: ORG,
    reason: i % 4 === 0 ? 'because' : null,
    region: 'in-mum',
    session_id: null,
    ts: new Date(Date.UTC(2026, 9, 23, 10, 0, i)).toISOString(),
  };
}

function buildChain(n: number): ChainEntry[] {
  const out: ChainEntry[] = [];
  for (let i = 0; i < n; i++) {
    const tail = out.length ? { seq: out[out.length - 1]!.seq, hash: out[out.length - 1]!.hash } : null;
    out.push(appendEntry(tail, fields(i)));
  }
  return out;
}

describe('hash chain', () => {
  it('starts from GENESIS_HASH and links entries', () => {
    const chain = buildChain(5);
    expect(chain[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(chain[0]!.seq).toBe(1);
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.prev_hash).toBe(chain[i - 1]!.hash);
    expect(computeEntryHash).toBe(hashAuditEntry);
    expect(verifyChain(chain, { orgId: ORG, region: 'in-mum' })).toEqual({
      ok: true,
      checked: 5,
      tail: chain[4]!.hash,
    });
  });

  it('hash depends only on the ten material keys (id and extras ignored)', () => {
    const [e] = buildChain(1);
    const withExtra = { ...e!, id: 'row-id', extra: 'ignored' } as ChainEntry;
    expect(hashAuditEntry(withExtra)).toBe(e!.hash);
    expect(Object.keys(materialOf(withExtra)).sort()).toEqual(
      ['action', 'actor', 'data', 'org_id', 'prev_hash', 'reason', 'region', 'seq', 'session_id', 'ts'].sort(),
    );
  });

  it('round trips material -> row -> material', () => {
    const [e] = buildChain(1);
    const row = JSON.parse(JSON.stringify(e)) as ChainEntry;
    row.ts = new Date(row.ts).toISOString();
    expect(hashAuditEntry(row)).toBe(e!.hash);
  });

  it('empty chain', () => {
    expect(verifyChain([], { orgId: ORG })).toEqual({ ok: true, checked: 0, tail: null });
    expect(verifyChain([], { orgId: ORG, start: { seq: 4, prevHash: 'a'.repeat(64) } })).toEqual({
      ok: true,
      checked: 0,
      tail: 'a'.repeat(64),
    });
  });

  it('detects an edited entry', () => {
    const chain = buildChain(6);
    const edited = chain.map((e) => ({ ...e }));
    edited[2] = { ...edited[2]!, data: { n: 999 } };
    expect(verifyChain(edited, { orgId: ORG })).toMatchObject({
      ok: false,
      checked: 2,
      failure: { kind: 'hash_mismatch', seq: 3 },
    });
    const relabelled = chain.map((e) => ({ ...e }));
    relabelled[4] = { ...relabelled[4]!, actor: { ...relabelled[4]!.actor, label: 'Mallory' } };
    expect(verifyChain(relabelled, { orgId: ORG }).failure).toEqual({ kind: 'hash_mismatch', seq: 5 });
  });

  it('detects an edit with a recomputed hash via prev_hash of the next entry', () => {
    const chain = buildChain(4);
    const forged = chain.map((e) => ({ ...e }));
    const changed = { ...forged[1]!, reason: 'rewritten' };
    changed.hash = hashAuditEntry(changed);
    forged[1] = changed;
    expect(verifyChain(forged, { orgId: ORG }).failure).toEqual({ kind: 'prev_mismatch', seq: 3 });
  });

  it('detects reordering', () => {
    const chain = buildChain(5);
    const swapped = [chain[0]!, chain[2]!, chain[1]!, chain[3]!, chain[4]!];
    expect(verifyChain(swapped, { orgId: ORG }).failure).toEqual({ kind: 'seq_gap', seq: 3 });
    const renumbered = swapped.map((e, i) => ({ ...e, seq: i + 1 }));
    expect(verifyChain(renumbered, { orgId: ORG }).failure?.kind).toBe('prev_mismatch');
  });

  it('detects removal', () => {
    const chain = buildChain(5);
    const removed = [chain[0]!, chain[1]!, chain[3]!, chain[4]!];
    expect(verifyChain(removed, { orgId: ORG }).failure).toEqual({ kind: 'seq_gap', seq: 4 });
    expect(verifyChain(chain.slice(1), { orgId: ORG }).failure).toEqual({ kind: 'seq_gap', seq: 2 });
  });

  it('detects org and region mismatches', () => {
    const chain = buildChain(2);
    expect(verifyChain(chain, { orgId: 'other' }).failure).toEqual({ kind: 'org_mismatch', seq: 1 });
    expect(verifyChain(chain, { orgId: ORG, region: 'eu-fra' }).failure).toEqual({ kind: 'region_mismatch', seq: 1 });
  });

  it('verifies a segment from a start point', () => {
    const chain = buildChain(6);
    const seg = chain.slice(3);
    expect(verifyChain(seg, { orgId: ORG, start: { seq: 4, prevHash: chain[2]!.hash } }).ok).toBe(true);
    expect(verifyChain(seg, { orgId: ORG, start: { seq: 4, prevHash: GENESIS_HASH } }).failure).toEqual({
      kind: 'prev_mismatch',
      seq: 4,
    });
  });

  it('detects tail regression against a checkpoint', () => {
    const chain = buildChain(5);
    const cp = { seq: 5, tail: chain[4]!.hash };
    expect(verifyChain(chain, { orgId: ORG, checkpoint: cp }).ok).toBe(true);
    expect(verifyChain(chain.slice(0, 3), { orgId: ORG, checkpoint: cp }).failure).toEqual({
      kind: 'tail_regression',
      seq: 3,
    });
    expect(verifyChain(chain, { orgId: ORG, checkpoint: { seq: 2, tail: 'f'.repeat(64) } }).failure).toEqual({
      kind: 'tail_regression',
      seq: 2,
    });
  });
});

describe('signed anchors', () => {
  async function anchoredChain(sig?: string) {
    const chain = buildChain(3);
    const ts = '2026-10-23T11:00:00.000Z';
    const pub = await publicKeyFromSeed(SEED);
    const key = publicKeyEntry(pub);
    const c = { org_id: ORG, seq: 3, tail: chain[2]!.hash, ts };
    const realSig = await signCheckpoint(c, SEED);
    expect(await verifyCheckpoint(c, realSig, key.kid, [key])).toBe(true);
    const anchor = appendEntry(
      { seq: 3, hash: chain[2]!.hash },
      {
        action: 'audit.anchored',
        actor: { id: null, label: 'system', type: 'system' },
        data: { seq: 3, tail: chain[2]!.hash, ts, kid: key.kid, sig: sig ?? realSig },
        org_id: ORG,
        reason: null,
        region: 'in-mum',
        session_id: null,
        ts,
      },
    );
    return { chain: [...chain, anchor], key, pub };
  }

  it('accepts a valid anchor with raw or base64url keys', async () => {
    const { chain, key, pub } = await anchoredChain();
    expect(verifyChain(chain, { orgId: ORG, pubKeys: [key] }).ok).toBe(true);
    expect(verifyChain(chain, { orgId: ORG, pubKeys: [{ kid: key.kid, pub: publicKeyToBase64url(pub) }] }).ok).toBe(
      true,
    );
  });

  it('rejects a forged anchor signature and an unknown key', async () => {
    const { chain, key } = await anchoredChain('A'.repeat(86));
    expect(verifyChain(chain, { orgId: ORG, pubKeys: [key] }).failure).toEqual({
      kind: 'anchor_bad_signature',
      seq: 4,
    });
    const good = await anchoredChain();
    expect(verifyChain(good.chain, { orgId: ORG, pubKeys: [] }).failure).toEqual({
      kind: 'anchor_bad_signature',
      seq: 4,
    });
  });

  it('detects an anchored entry rewritten after anchoring', async () => {
    const { chain, key } = await anchoredChain();
    // Rewrite the whole chain consistently (attacker with table access) but keep the signed anchor data.
    const rewritten: ChainEntry[] = [];
    for (const [i, e] of chain.entries()) {
      const tail = i ? { seq: rewritten[i - 1]!.seq, hash: rewritten[i - 1]!.hash } : null;
      const f = { ...materialOf(e) } as Omit<AuditMaterial, 'prev_hash' | 'seq'> & Partial<AuditMaterial>;
      delete f.prev_hash;
      delete f.seq;
      if (i === 1) f.reason = 'rewritten';
      rewritten.push(appendEntry(tail, f));
    }
    expect(verifyChain(rewritten, { orgId: ORG }).ok).toBe(true);
    expect(verifyChain(rewritten, { orgId: ORG, pubKeys: [key] }).failure).toEqual({ kind: 'anchor_mismatch', seq: 4 });
  });

  it('JSONL export verifies offline and detects edits', async () => {
    const { chain, pub, key } = await anchoredChain();
    const header = {
      ia_audit_export: 1 as const,
      orgId: ORG,
      orgSlug: 'acme',
      region: 'in-mum' as const,
      exportedAt: '2026-10-23T12:00:00.000Z',
      startSeq: 1,
      startPrevHash: GENESIS_HASH,
      count: chain.length,
      keys: [{ kid: key.kid, pub: publicKeyToBase64url(pub) }],
    };
    const text = buildAuditJsonl(
      header,
      chain.map((e, i) => ({ ...e, id: `id-${i}` })),
    );
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseAuditJsonl(text);
    expect(parsed.ok && parsed.entries.length).toBe(4);
    expect(verifyAuditJsonl(text)).toMatchObject({ ok: true, checked: 4, countMatches: true });
    const tampered = text.replace('"reason":"because"', '"reason":"changed"');
    expect(tampered).not.toBe(text);
    expect(verifyAuditJsonl(tampered).failure?.kind).toBe('hash_mismatch');
    expect(verifyAuditJsonl(text.split('\n').slice(1).join('\n')).malformed).toMatch(/line 1/);
  });
});
