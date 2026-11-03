// scripts/verify-erasure.mjs (docs/specs/phase-f-contracts.md sections 5.5, 15.4): a good and a tampered certificate
// with --keys and --pub, a field added after signing, a final entry that does not recompute, and --export --digest on
// a good and a tampered set (an export entry changed, a digest with a gap, a digest that does not end at the tail).
// Runs the real CLI as a child process against a synthetic chain signed by the built @indiansassist/shared.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadShared } from '../smoke/shared.mjs';
import { digestItems, parseArgs, verifyCertificateText } from '../verify-erasure.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-erasure.mjs');
const SEED = '6'.repeat(64);
const ORG = '0b8e1f3a-2c4d-4e5f-9a6b-7c8d9e0f1a2b';
const ERASURE = 'c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f';

let dir;
let shared;
let key;
let entries;
let cert;
let exportText;
let digest;

function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (err) {
    return { code: err.status, out: String(err.stdout).trim() };
  }
}

function file(name, content) {
  const p = join(dir, name);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return p;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ia-verify-erasure-'));
  shared = await loadShared();
  const pub = await shared.publicKeyFromSeed(SEED);
  key = { kid: shared.kidOf(pub), pub: shared.publicKeyToBase64url(pub) };
  const base = { org_id: ORG, region: 'in-mum', session_id: null, reason: null };
  entries = [];
  let tail = null;
  const push = (fields) => {
    const e = shared.appendEntry(tail, { ...base, ...fields });
    entries.push(e);
    tail = { seq: e.seq, hash: e.hash };
  };
  push({ action: 'auth.signup', actor: { id: ORG, label: 'Synthetic Admin', type: 'user' }, data: { emailHash: 'a'.repeat(64) }, ts: '2026-11-02T10:00:00.000Z' });
  push({ action: 'org.erasure_requested', actor: { id: ORG, label: 'Synthetic Admin', type: 'user' }, data: { erasureId: ERASURE, solo: false }, ts: '2026-11-02T10:01:00.000Z' });
  push({ action: 'org.erasure_approved', actor: { id: ORG, label: 'Second Admin', type: 'user' }, data: { erasureId: ERASURE, coolingOffUntil: '2026-11-09T10:02:00.000Z' }, ts: '2026-11-02T10:02:00.000Z' });
  // The export is taken here, during cooling-off.
  exportText = shared.buildAuditJsonl(
    { ia_audit_export: 1, orgId: ORG, orgSlug: 'synthetic-org', region: 'in-mum', exportedAt: '2026-11-03T00:00:00.000Z', startSeq: 1, startPrevHash: '0'.repeat(64), count: entries.length, keys: [key] },
    entries,
  );
  push({ action: 'org.erasure_started', actor: { id: null, label: 'system', type: 'system' }, data: { erasureId: ERASURE }, ts: '2026-11-09T10:02:10.000Z' });
  push({ action: 'org.erased', actor: { id: null, label: 'system', type: 'system' }, data: { erasureId: ERASURE, entriesBefore: 4, counts: { 'deleted:auth_session': 2 } }, ts: '2026-11-09T10:02:20.000Z' });
  digest = { items: entries.map((e) => ({ seq: e.seq, hash: e.hash, prevHash: e.prev_hash })), nextAfter: null };
  cert = await shared.signErasureCertificate(
    {
      v: 1,
      erasureId: ERASURE,
      orgId: ORG,
      region: 'in-mum',
      requestedAt: '2026-11-02T10:01:00.000Z',
      approvedAt: '2026-11-02T10:02:00.000Z',
      executedAt: '2026-11-09T10:02:10.000Z',
      completedAt: '2026-11-09T10:40:00.000Z',
      chain: { entries: entries.length, tail: tail.hash, verified: true, failure: null, finalEntry: entries[entries.length - 1] },
      deleted: { auth_session: 2 },
      scrubbed: { user: 2 },
      objectBytes: 0,
      externalFlows: [],
      backups: 'backup retention not stated',
    },
    SEED,
    key.kid,
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('verify-erasure CLI', () => {
  it('a good certificate: OK <kid> <sha256> with --keys and --pub', () => {
    const c = file('good.json', cert);
    const ok = `OK ${key.kid} ${cert.signature.sha256}`;
    expect(run([c, '--keys', file('wk.json', { keys: [{ ...key, alg: 'Ed25519' }] })])).toEqual({ code: 0, out: ok });
    expect(run([c, '--pub', key.pub])).toEqual({ code: 0, out: ok });
  });

  it('a tampered certificate or an unsigned field added after signing fails', () => {
    const tampered = file('tampered.json', { ...cert, objectBytes: 1 });
    const extra = file('extra.json', { ...cert, footnote: 'added later' });
    expect(run([tampered, '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL bad_signature' });
    expect(run([extra, '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL bad_signature' });
    const other = file('other.json', { keys: [{ kid: '0123456789abcdef', pub: key.pub }] });
    expect(run([file('good2.json', cert), '--keys', other])).toEqual({ code: 1, out: 'FAIL unknown_kid' });
  });

  it('--export --digest on a good set: OK', () => {
    const args = [file('c.json', cert), '--pub', key.pub, '--export', file('export.jsonl', exportText), '--digest', file('digest.json', digest)];
    expect(run(args)).toEqual({ code: 0, out: `OK ${key.kid} ${cert.signature.sha256}` });
    // A saved list of pages and a bare array are accepted too.
    expect(run([...args.slice(0, 5), '--digest', file('pages.json', [{ items: digest.items.slice(0, 2), nextAfter: 2 }, { items: digest.items.slice(2), nextAfter: null }])]).code).toBe(0);
    expect(run([...args.slice(0, 5), '--digest', file('bare.json', digest.items)]).code).toBe(0);
  });

  it('--export --digest on a tampered set fails', () => {
    const c = file('c3.json', cert);
    const good = file('digest3.json', digest);
    const changed = exportText.replace('"solo":false', '"solo":true');
    expect(run([c, '--pub', key.pub, '--export', file('changed.jsonl', changed), '--digest', good])).toEqual({ code: 1, out: 'FAIL export_mismatch (seq 2)' });
    const gap = { items: digest.items.filter((i) => i.seq !== 3) };
    expect(run([c, '--pub', key.pub, '--export', file('e3.jsonl', exportText), '--digest', file('gap.json', gap)])).toEqual({ code: 1, out: 'FAIL digest_gap (seq 4)' });
    const short = { items: digest.items.slice(0, 4) };
    expect(run([c, '--pub', key.pub, '--export', file('e4.jsonl', exportText), '--digest', file('short.json', short)])).toEqual({ code: 1, out: 'FAIL digest_tail_mismatch' });
    // A digest whose hashes were rewritten (still linked) no longer matches the exported entries.
    let prev = '0'.repeat(64);
    const forged = digest.items.map((i) => {
      const h = i.seq === 1 ? 'f'.repeat(64) : i.hash;
      const out = { seq: i.seq, hash: h, prevHash: prev };
      prev = h;
      return out;
    });
    expect(run([c, '--pub', key.pub, '--export', file('e5.jsonl', exportText), '--digest', file('forged.json', { items: forged })]).out).toMatch(/^FAIL /);
  });

  it('a final entry that does not recompute to the tail fails even when signed', async () => {
    const final = { ...cert.chain.finalEntry, data: { ...cert.chain.finalEntry.data, entriesBefore: 3 } };
    const { signature: _s, ...unsigned } = cert;
    const resigned = await shared.signErasureCertificate({ ...unsigned, chain: { ...cert.chain, finalEntry: final } }, SEED, key.kid);
    expect(run([file('final.json', resigned), '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL final_entry_mismatch' });
  });

  it('usage, unreadable and malformed', async () => {
    expect(run([])).toEqual({ code: 1, out: 'FAIL usage' });
    expect(run([file('x.json', cert)])).toEqual({ code: 1, out: 'FAIL usage' });
    expect(run([file('y.json', cert), '--pub', key.pub, '--export', 'e.jsonl'])).toEqual({ code: 1, out: 'FAIL usage' });
    expect(run([join(dir, 'missing.json'), '--pub', key.pub]).out).toMatch(/^FAIL unreadable/);
    expect(run([file('nojson.json', 'not json'), '--pub', key.pub]).out).toBe('FAIL malformed (the certificate is not JSON)');
    expect(() => parseArgs(['a', '--keys', 'k', '--pub', 'p'])).toThrow(/exactly one/);
    expect(digestItems({ items: [1] })).toEqual([1]);
    expect((await verifyCertificateText(JSON.stringify(cert), { pub: key.pub })).ok).toBe(true);
  });
});
