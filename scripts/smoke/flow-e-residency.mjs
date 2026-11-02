// Phase E smoke flow, stream residency (docs/specs/phase-e-contracts.md sections 6.2-6.4, 15.5), against a running
// api: a throwaway org's report carries every section 6.2 field and a signature that verifies against the published
// keys; the signed download has the contract headers, is chained once and verifies offline with
// scripts/verify-residency.mjs (--keys and --fetch), while a tampered copy and a copy with an unsigned extra field are
// refused; a technician is refused both routes. Picked up by scripts/smoke-e.mjs. Emails are synthetic.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from './http.mjs';
import { check, eq } from './runner.mjs';
import { loadShared } from './shared.mjs';

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-residency.mjs');
const CATEGORIES = ['identity', 'sessions', 'recordings', 'audit', 'files', 'fleet', 'summaries', 'tickets'];
const E_FIELDS = ['dataCategories', 'dataFlows', 'subprocessors', 'activity30d', 'sso', 'recorder', 'erasure', 'signature'];
const BCD_FIELDS = ['extensionPolicy', 'relaySessions', 'relayBytes', 'recordingRetentionDays', 'agentSessions', 'elevationGrants', 'playbookRuns', 'devices', 'onlineDevices', 'unattendedSessions30d', 'wakeAttempts30d', 'deviceActions30d', 'amtPlainHttpDevices'];

/** Runs the verifier CLI; resolves `{ code, out }` (never rejects). */
function verifyCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [VERIFY, ...args], { encoding: 'utf8', timeout: 30_000 }, (err, stdout) =>
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout).trim() }),
    );
  });
}

/** @param {import('./runner.mjs').Runner} run */
export async function flowSteps(run, ctx) {
  const { api, cfg, state } = ctx;
  const shared = await loadShared();
  const dir = mkdtempSync(join(tmpdir(), 'ia-smoke-residency-'));
  const suffix = randomBytes(4).toString('hex');
  try {
    await run.step('residency: well-known keys and a throwaway org', async () => {
      const wk = await api.expect('GET', '/.well-known/indiansassist.json');
      check(Array.isArray(wk.keys) && wk.keys.length > 0, 'well-known lists no keys');
      state.wellKnown = wk;
      if (!cfg.webOrigin) cfg.webOrigin = new URL(wk.join).origin;
      api.origin = cfg.webOrigin;
      const r = await api.expect(
        'POST',
        '/api/v1/auth/signup',
        { orgName: `Smoke Residency ${suffix}`, name: `Smoke Admin ${suffix}`, email: `smoke-res-${suffix}@example.com`, password: `Smoke-${randomBytes(12).toString('base64url')}` },
        [201],
      );
      state.org = r.org;
      return `org ${r.org.slug}, ${wk.keys.length} published key(s)`;
    });

    await run.step('residency: GET /orgs/current/residency carries every B, C, D and E field', async () => {
      const r = await api.request('GET', '/api/v1/orgs/current/residency');
      eq(r.status, 200, 'status');
      const report = JSON.parse(r.text);
      for (const k of [...BCD_FIELDS, ...E_FIELDS]) check(k in report, `report lacks ${k}`);
      eq(report.dataCategories.map((c) => c.category).join(','), CATEGORIES.join(','), 'categories in order');
      eq(report.erasure.available, false, 'erasure.available');
      check(!/erasure mechanism \(Phase E\)/.test(report.retention.piiInChain), 'piiInChain still promises an erasure mechanism');
      eq(report.retention.recordings, report.recordingRetentionDays ? `deleted ${report.recordingRetentionDays} days after recording (org setting)` : 'until deleted by an org_admin', 'retention.recordings');
      check(shared.residencyReportSchema.safeParse(report).success, 'report does not match residencyReportSchema');
      const v = shared.verifyResidencyReport(report, state.wellKnown.keys);
      check(v.ok, `signature does not verify: ${v.cause}`);
      check(state.wellKnown.keys.some((k) => k.kid === report.signature.kid && k.pub === report.signature.pub), 'signature kid/pub not the published key');
      return `${report.dataFlows.length} flow(s), kid ${report.signature.kid}, sha256 ${report.signature.sha256.slice(0, 12)}...`;
    });

    await run.step('residency: signed.json download headers, chained once as residency.report_issued', async () => {
      const r = await api.request('GET', '/api/v1/orgs/current/residency/signed.json');
      eq(r.status, 200, 'status');
      check(/^application\/json/.test(r.headers.get('content-type') ?? ''), 'content-type is not application/json');
      eq(r.headers.get('cache-control'), 'no-store', 'cache-control');
      const report = JSON.parse(r.text);
      eq(r.headers.get('content-disposition'), `attachment; filename="residency-${state.org.slug}-${report.generatedAt.slice(0, 10)}.json"`, 'content-disposition');
      state.signedText = r.text;
      state.signed = report;
      const audit = await api.expect('GET', '/api/v1/audit?action=residency.report_issued&limit=10');
      const mine = audit.items.filter((e) => e.data?.sha256 === report.signature.sha256);
      eq(mine.length, 1, 'residency.report_issued entries for this download');
      eq(mine[0].data.kid, report.signature.kid, 'chained kid');
      eq(mine[0].actor.type, 'user', 'chained actor');
      return `chained seq ${mine[0].seq}`;
    });

    await run.step('residency: scripts/verify-residency.mjs verifies the download offline (--keys) and with --fetch', async () => {
      const file = join(dir, 'report.json');
      writeFileSync(file, state.signedText);
      const keys = join(dir, 'well-known.json');
      writeFileSync(keys, JSON.stringify(state.wellKnown));
      const want = `OK ${state.signed.signature.kid} ${state.signed.signature.sha256}`;
      const a = await verifyCli([file, '--keys', keys]);
      eq(`${a.code} ${a.out}`, `0 ${want}`, '--keys');
      const b = await verifyCli([file, '--fetch', cfg.apiUrl]);
      eq(`${b.code} ${b.out}`, `0 ${want}`, '--fetch');
      return want;
    });

    await run.step('residency: a tampered report and an unsigned extra field are refused', async () => {
      const keys = join(dir, 'well-known.json');
      const tampered = join(dir, 'tampered.json');
      writeFileSync(tampered, JSON.stringify({ ...state.signed, statement: `${state.signed.statement} Nothing leaves the region.` }));
      const a = await verifyCli([tampered, '--keys', keys]);
      eq(`${a.code} ${a.out}`, '1 FAIL bad_signature', 'tampered');
      const extra = join(dir, 'extra.json');
      writeFileSync(extra, JSON.stringify({ ...state.signed, auditorNote: 'added after signing' }));
      const b = await verifyCli([extra, '--keys', keys]);
      eq(`${b.code} ${b.out}`, '1 FAIL bad_signature', 'extra field');
      const unknown = await verifyCli([join(dir, 'report.json'), '--pub', 'A'.repeat(43)]);
      eq(`${unknown.code} ${unknown.out}`, '1 FAIL unknown_kid', 'unpublished key');
      return 'bad_signature, bad_signature, unknown_kid';
    });

    await run.step('residency: a technician is refused both routes (403)', async () => {
      const inv = await api.expect('POST', '/api/v1/users/invite', { email: `smoke-res-tech-${suffix}@example.com`, name: `Smoke Tech ${suffix}`, role: 'technician' }, [201]);
      const tech = new ApiClient(cfg.apiUrl, { origin: cfg.webOrigin, fetchImpl: ctx.fetchImpl });
      await tech.expect('POST', '/api/v1/auth/accept-invite', { invite: inv.inviteUrl.split('#i=')[1], name: `Smoke Tech ${suffix}`, password: `Smoke-${randomBytes(12).toString('base64url')}` });
      for (const path of ['/api/v1/orgs/current/residency', '/api/v1/orgs/current/residency/signed.json']) {
        const r = await tech.request('GET', path);
        eq(r.status, 403, `${path} as technician`);
      }
      return 'both 403';
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
