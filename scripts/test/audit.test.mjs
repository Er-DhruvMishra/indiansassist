// Unit tests of the smoke test's audit helpers on a real chain built with @indiansassist/shared.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyExport, verifySessionAudit, wireToChainEntry } from '../smoke/audit.mjs';
import { loadShared } from '../smoke/shared.mjs';

let shared;
const orgId = randomUUID();
const sid = randomUUID();
let chain;
let wire;

beforeAll(async () => {
  shared = await loadShared();
  chain = [];
  const add = (action, sessionId, data = {}) => {
    const e = shared.appendEntry(chain.at(-1) ?? null, {
      action,
      actor: { id: null, label: 'system', type: 'system' },
      data,
      org_id: orgId,
      reason: null,
      region: 'in-mum',
      session_id: sessionId,
      ts: new Date(Date.UTC(2026, 9, 23, 10, 0, chain.length)).toISOString(),
    });
    chain.push({ ...e, id: randomUUID() });
  };
  add('auth.signup', null, { emailHash: 'x' });
  add('session.knock', sid, { tokenId: 't' });
  add('session.accepted', sid, { tokenId: 't', onBehalfOf: null });
  add('token.created', null, { tokenId: 'u' }); // gap inside the session's entries
  add('session.ended', sid, { endReason: 'assist_ended', durationMs: 5, path: 'unknown' });
  wire = chain
    .filter((e) => e.session_id === sid)
    .map((e) => ({
      id: e.id,
      seq: e.seq,
      sessionId: e.session_id,
      actor: e.actor,
      action: e.action,
      reason: e.reason,
      region: e.region,
      ts: e.ts,
      data: e.data,
      prevHash: e.prev_hash,
      hash: e.hash,
    }));
});

describe('verifySessionAudit', () => {
  it('accepts a non-contiguous session subset and splits it into verifyChain segments', () => {
    const r = verifySessionAudit(shared, wire, {
      orgId,
      sessionId: sid,
      region: 'in-mum',
      requiredActions: ['session.knock', 'session.accepted', 'session.ended'],
      expectedTail: chain.at(-1).hash,
    });
    expect(r.problems).toEqual([]);
    expect(r.checked).toBe(3);
    expect(r.segments).toBe(2);
  });

  it('round-trips wire -> chain entry to the same hash', () => {
    for (const w of wire) expect(shared.hashAuditEntry(wireToChainEntry(w, orgId))).toBe(w.hash);
  });

  it('reports tampering, broken links, missing actions and a wrong tail', () => {
    const tampered = wire.map((w, i) => (i === 0 ? { ...w, data: { tokenId: 'other' } } : w));
    const relinked = wire.map((w, i) => (i === 1 ? { ...w, prevHash: '1'.repeat(64) } : w));
    const opts = { orgId, sessionId: sid, region: 'in-mum' };
    expect(verifySessionAudit(shared, tampered, opts).problems.join()).toMatch(/hash mismatch/);
    expect(verifySessionAudit(shared, relinked, opts).problems.join()).toMatch(/prevHash does not link/);
    expect(verifySessionAudit(shared, wire, { ...opts, requiredActions: ['session.started'] }).problems.join()).toMatch(
      /missing action session.started/,
    );
    expect(verifySessionAudit(shared, wire, { ...opts, expectedTail: '2'.repeat(64) }).problems.join()).toMatch(
      /!= hashChainTail/,
    );
    expect(verifySessionAudit(shared, wire, { ...opts, region: 'eu-fra' }).ok).toBe(false);
  });
});

describe('verifyExport', () => {
  const header = () => ({
    ia_audit_export: 1,
    orgId,
    orgSlug: 'acme',
    region: 'in-mum',
    exportedAt: new Date().toISOString(),
    startSeq: 1,
    startPrevHash: shared.GENESIS_HASH,
    count: chain.length,
    keys: [{ kid: '0'.repeat(16), pub: 'A'.repeat(43) }],
  });

  it('verifies a full export that contains the session entries', () => {
    const text = shared.buildAuditJsonl(header(), chain);
    const r = verifyExport(shared, text, { orgId, region: 'in-mum', mustContain: wire.map((w) => w.hash) });
    expect(r.problems).toEqual([]);
    expect(r.checked).toBe(chain.length);
  });

  it('rejects a reordered export, a missing header and missing session entries', () => {
    const swapped = [chain[0], chain[2], chain[1], ...chain.slice(3)];
    expect(verifyExport(shared, shared.buildAuditJsonl(header(), swapped), { orgId }).problems.join()).toMatch(
      /verifyChain failed/,
    );
    const noHeader = shared.buildAuditJsonl(header(), chain).split('\n').slice(1).join('\n');
    expect(verifyExport(shared, noHeader, { orgId }).problems.join()).toMatch(/malformed/);
    expect(
      verifyExport(shared, shared.buildAuditJsonl(header(), chain), { orgId, mustContain: ['f'.repeat(64)] }).ok,
    ).toBe(false);
  });
});
