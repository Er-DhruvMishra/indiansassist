// scripts/verify-residency.mjs (docs/specs/phase-e-contracts.md sections 6.3c, 15.5): a good and a tampered report
// with --keys and --pub, an unsigned field added after signing, a report signed by a retired key verifying with a
// well-known list that still publishes it, the causes and exit codes, and the argument parser. Runs the real CLI
// as a child process against reports signed by the built @indiansassist/shared.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadShared } from '../smoke/shared.mjs';
import { keysFromDocument, parseArgs, verifyReportText } from '../verify-residency.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-residency.mjs');
const SEED = '8'.repeat(64);
const RETIRED_SEED = '9'.repeat(64);

let dir;
let shared;
let key;
let retired;
let signed;
let signedByRetired;

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
  dir = mkdtempSync(join(tmpdir(), 'ia-verify-residency-'));
  shared = await loadShared();
  const pub = await shared.publicKeyFromSeed(SEED);
  const rpub = await shared.publicKeyFromSeed(RETIRED_SEED);
  key = { kid: shared.kidOf(pub), pub: shared.publicKeyToBase64url(pub) };
  retired = { kid: shared.kidOf(rpub), pub: shared.publicKeyToBase64url(rpub) };
  const report = {
    org: { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', name: 'Acme', slug: 'acme', dataRegion: 'in-mum' },
    generatedAt: '2026-11-02T10:00:00.000Z',
    statement: 'All session metadata, recordings and audit entries for Acme are stored and served in India (Mumbai).',
    dataFlows: [{ kind: 'ai_provider', name: 'Anthropic (Claude)', leavesRegion: 'yes', enabled: true }],
    erasure: { available: false, note: 'not implemented' },
  };
  signed = await shared.signResidencyReport(report, SEED, key.kid);
  signedByRetired = await shared.signResidencyReport(report, RETIRED_SEED, retired.kid);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('verify-residency CLI', () => {
  it('a good report: OK <kid> <sha256> with --keys (a well-known document) and with --pub', () => {
    const report = file('good.json', signed);
    const keys = file('well-known.json', { v: 1, region: 'in-mum', keys: [{ kid: key.kid, alg: 'Ed25519', pub: key.pub, createdAt: '2026-01-01T00:00:00.000Z' }] });
    const ok = `OK ${key.kid} ${signed.signature.sha256}`;
    expect(run([report, '--keys', keys])).toEqual({ code: 0, out: ok });
    expect(run([report, '--pub', key.pub])).toEqual({ code: 0, out: ok });
    // A bare array of keys is accepted too.
    expect(run([report, '--keys', file('array.json', [key])])).toEqual({ code: 0, out: ok });
  });

  it('a tampered report fails with bad_signature, with either key source', () => {
    const tampered = file('tampered.json', JSON.stringify(signed, null, 2).replace('"leavesRegion": "yes"', '"leavesRegion": "no"'));
    const keys = file('keys.json', { keys: [key] });
    expect(run([tampered, '--keys', keys])).toEqual({ code: 1, out: 'FAIL bad_signature' });
    expect(run([tampered, '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL bad_signature' });
  });

  it('an unsigned top-level field added after signing fails (verification is over the raw JSON)', () => {
    const extra = file('extra.json', { ...signed, footnote: 'added later' });
    expect(run([extra, '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL bad_signature' });
  });

  it('after a key rotation an old report verifies while the retired key stays published', () => {
    const old = file('old.json', signedByRetired);
    const rotated = file('rotated.json', { keys: [key, retired] });
    const currentOnly = file('current.json', { keys: [key] });
    expect(run([old, '--keys', rotated])).toEqual({ code: 0, out: `OK ${retired.kid} ${signedByRetired.signature.sha256}` });
    expect(run([old, '--keys', currentOnly])).toEqual({ code: 1, out: 'FAIL unknown_kid' });
    // --pub of the wrong key is an unknown kid, never a fallback to signature.pub.
    expect(run([old, '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL unknown_kid' });
  });

  it('malformed, unreadable and usage errors exit 1', () => {
    expect(run([file('notjson.json', '{nope'), '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL malformed (the report is not JSON)' });
    const { signature: _s, ...unsigned } = signed;
    expect(run([file('unsigned.json', unsigned), '--pub', key.pub])).toEqual({ code: 1, out: 'FAIL malformed' });
    expect(run([join(dir, 'missing.json'), '--pub', key.pub]).out).toMatch(/^FAIL unreadable/);
    expect(run([file('g2.json', signed), '--pub', 'short'])).toMatchObject({ code: 1, out: expect.stringMatching(/^FAIL unreadable \(keys:/) });
    expect(run([file('g3.json', signed)])).toEqual({ code: 1, out: 'FAIL usage' });
    expect(run([file('g4.json', signed), '--pub', key.pub, '--keys', 'x.json'])).toEqual({ code: 1, out: 'FAIL usage' });
  });
});

describe('verify-residency helpers', () => {
  it('parseArgs takes one report and exactly one key source', () => {
    expect(parseArgs(['r.json', '--pub', 'abc'])).toEqual({ file: 'r.json', keys: null, pub: 'abc', fetch: null });
    expect(parseArgs(['--keys', 'k.json', 'r.json'])).toMatchObject({ file: 'r.json', keys: 'k.json' });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(['r.json'])).toThrow(/exactly one/);
    expect(() => parseArgs(['r.json', '--pub'])).toThrow(/needs a value/);
    expect(() => parseArgs(['r.json', '--bogus', 'x'])).toThrow(/unknown option/);
    expect(() => parseArgs(['a.json', 'b.json', '--pub', 'x'])).toThrow(/unexpected argument/);
  });

  it('keysFromDocument reads Ed25519 entries of a well-known document or an array', () => {
    expect(keysFromDocument({ keys: [{ kid: 'a', pub: 'b', alg: 'Ed25519' }, { kid: 'c', pub: 'd', alg: 'RS256' }] })).toEqual([{ kid: 'a', pub: 'b' }]);
    expect(keysFromDocument([{ kid: 'a', pub: 'b' }])).toEqual([{ kid: 'a', pub: 'b' }]);
    expect(() => keysFromDocument({})).toThrow(/keys/);
  });

  it('--fetch reads the keys from <origin>/.well-known/indiansassist.json (an injected fetch, no network)', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ keys: [key, retired] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const r = await verifyReportText(JSON.stringify(signedByRetired), { fetch: 'https://in.example/' }, { fetchImpl });
    expect(r).toEqual({ ok: true, line: `OK ${retired.kid} ${signedByRetired.signature.sha256}` });
    expect(seen).toEqual(['https://in.example/.well-known/indiansassist.json']);
    const failing = async () => new Response('nope', { status: 503 });
    expect((await verifyReportText(JSON.stringify(signed), { fetch: 'https://in.example' }, { fetchImpl: failing })).line).toMatch(/^FAIL unreadable \(keys: GET .* answered 503\)/);
  });
});
