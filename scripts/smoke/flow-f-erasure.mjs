// Phase F smoke flow, stream erasure (docs/specs/phase-f-contracts.md sections 5, 15.4), against a running api started
// with ERASURE_DEV_COOLING_OFF_SEC (development only; 5 is the documented value): a throwaway org with two
// administrators (the second invited by the first, so the second requests and the first approves, 5.2b), the request
// and the approval with fresh sign-ins and the typed slug, the residency report showing the schedule, an audit export
// taken during cooling-off, the execution by the api's own sweeper, the signed certificate and the chain digest
// fetched, and `scripts/verify-erasure.mjs --keys --export --digest` answering OK; afterwards sign-in and reads are
// refused (the cookie sessions are gone, the addresses scrubbed). Picked up by scripts/smoke-f.mjs. Every address is synthetic (@example.com).

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient } from './http.mjs';
import { check, eq } from './runner.mjs';
import { loadShared } from './shared.mjs';

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify-erasure.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long the api's own sweeper may take to run the whole erasure (it passes every 10 s). */
const EXECUTION_DEADLINE_MS = Number(process.env.SMOKE_ERASURE_DEADLINE_MS) || 120_000;
/** The development shortening the api runs with (5.2c); the approver must be at least this old. */
const DEV_SEC = Number(process.env.SMOKE_ERASURE_DEV_SEC) || 5;

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
  const dir = mkdtempSync(join(tmpdir(), 'ia-smoke-erasure-'));
  const suffix = randomBytes(4).toString('hex');
  const pw = `Smoke-${randomBytes(12).toString('base64url')}`;
  const second = new ApiClient(cfg.apiUrl, { fetchImpl: ctx.fetchImpl });
  try {
    await run.step('erasure: a throwaway org with two administrators', async () => {
      const wk = await api.expect('GET', '/.well-known/indiansassist.json');
      state.wellKnown = wk;
      if (!cfg.webOrigin) cfg.webOrigin = new URL(wk.join).origin;
      api.origin = cfg.webOrigin;
      second.origin = cfg.webOrigin;
      const r = await api.expect('POST', '/api/v1/auth/signup', { orgName: `Smoke Erasure ${suffix}`, name: `Smoke First ${suffix}`, email: `smoke-erase-a-${suffix}@example.com`, password: pw }, [201]);
      state.org = r.org;
      state.signedUpAt = Date.now();
      const inv = await api.expect('POST', '/api/v1/users/invite', { email: `smoke-erase-b-${suffix}@example.com`, name: `Smoke Second ${suffix}`, role: 'org_admin' }, [201]);
      const secret = inv.inviteUrl.split('#i=')[1];
      check(secret, 'the invite reply has no inviteUrl');
      await second.expect('POST', '/api/v1/auth/accept-invite', { invite: secret, name: `Smoke Second ${suffix}`, password: pw });
      return `org ${r.org.slug}`;
    });

    await run.step('erasure: the invited admin requests (typed slug); the first admin approves', async () => {
      // 5.2b: the first admin must have been an admin for the (shortened) minimum age before approving.
      const wait = state.signedUpAt + DEV_SEC * 1000 + 500 - Date.now();
      if (wait > 0) await sleep(wait);
      const wrong = await second.request('POST', '/api/v1/orgs/current/erasure', { confirmSlug: `${state.org.slug}-x` });
      eq(wrong.status, 400, 'a wrong slug');
      const req = await second.request('POST', '/api/v1/orgs/current/erasure', { confirmSlug: state.org.slug, reason: 'smoke test of a throwaway org' });
      if (req.status === 409 && req.json?.error?.code === 'erasure_second_admin')
        throw new Error('no eligible approver: start the api with ERASURE_DEV_COOLING_OFF_SEC (development only), e.g. 5');
      eq(req.status, 201, 'request');
      state.erasure = req.json.erasure;
      eq(state.erasure.state, 'pending_approval', 'state after the request');
      const self = await second.request('POST', `/api/v1/orgs/current/erasure/${state.erasure.id}/approve`, { confirmSlug: state.org.slug });
      eq(self.json?.error?.code, 'erasure_second_admin', 'the requester approving');
      const ok = await api.expect('POST', `/api/v1/orgs/current/erasure/${state.erasure.id}/approve`, { confirmSlug: state.org.slug });
      eq(ok.erasure.state, 'cooling_off', 'state after the approval');
      check(ok.erasure.certificateUrl.endsWith(`/api/v1/erasures/${state.erasure.id}/certificate`), 'certificateUrl');
      const report = await api.expect('GET', '/api/v1/orgs/current/residency');
      eq(report.erasure.available, true, 'residency erasure.available');
      eq(report.erasure.state, 'cooling_off', 'residency erasure.state');
      return `scheduled for ${ok.erasure.coolingOffUntil}`;
    });

    await run.step('erasure: the audit export taken during cooling-off', async () => {
      const r = await api.request('POST', '/api/v1/audit/export', {});
      eq(r.status, 200, 'export');
      state.exportText = r.text;
      const parsed = shared.parseAuditJsonl(r.text);
      check(parsed.ok, 'the export does not parse');
      return `${parsed.entries.length} entries`;
    });

    await run.step('erasure: executed by the sweeper; the certificate is served', async () => {
      const deadline = Date.now() + EXECUTION_DEADLINE_MS;
      let res;
      for (;;) {
        res = await api.request('GET', `/api/v1/erasures/${state.erasure.id}/certificate`);
        if (res.status === 200 || Date.now() > deadline) break;
        await sleep(2000);
      }
      eq(res.status, 200, 'certificate (waited for the sweeper)');
      eq(res.headers.get('cache-control'), 'no-store', 'cache-control');
      state.certText = res.text;
      const cert = JSON.parse(res.text);
      const v = shared.verifyErasureCertificate(cert, state.wellKnown.keys);
      check(v.ok, `certificate does not verify: ${v.cause}`);
      eq(cert.chain.verified, true, 'chain.verified');
      eq(cert.chain.finalEntry.action, 'org.erased', 'the final entry');
      for (const s of [suffix, state.org.slug, '@example.com']) check(!res.text.includes(s), `the certificate holds "${s}"`);
      return `${cert.chain.entries} entries, kid ${cert.signature.kid}`;
    });

    await run.step('erasure: the chain digest; verify-erasure --keys --export --digest is OK', async () => {
      const items = [];
      let after = 0;
      for (;;) {
        const page = await api.expect('GET', `/api/v1/erasures/${state.erasure.id}/chain-digest?after=${after}&limit=10000`);
        items.push(...page.items);
        if (page.nextAfter === null) break;
        after = page.nextAfter;
      }
      const certFile = join(dir, 'certificate.json');
      const keysFile = join(dir, 'well-known.json');
      const exportFile = join(dir, 'export.jsonl');
      const digestFile = join(dir, 'digest.json');
      writeFileSync(certFile, state.certText);
      writeFileSync(keysFile, JSON.stringify(state.wellKnown));
      writeFileSync(exportFile, state.exportText);
      writeFileSync(digestFile, JSON.stringify({ items }));
      const ok = await verifyCli([certFile, '--keys', keysFile, '--export', exportFile, '--digest', digestFile]);
      eq(ok.code, 0, `verify-erasure (${ok.out})`);
      check(ok.out.startsWith('OK '), ok.out);
      writeFileSync(join(dir, 'tampered.jsonl'), state.exportText.replace(/"count":\d+/, '"count":0').replace(/"action":"auth\.signup"/, '"action":"auth.signin"'));
      const bad = await verifyCli([certFile, '--keys', keysFile, '--export', join(dir, 'tampered.jsonl'), '--digest', digestFile]);
      eq(bad.code, 1, 'a tampered export');
      return ok.out;
    });

    await run.step('erasure: afterwards sign-in and reads are refused', async () => {
      // Step 2 deleted every cookie session (401); a session that survived would meet the org_erasing gate (409).
      const me = await api.request('GET', '/api/v1/auth/me');
      check(me.status === 401 || (me.status === 409 && me.json?.error?.code === 'org_erasing'), `GET /auth/me answered ${me.status}`);
      const fresh = new ApiClient(cfg.apiUrl, { origin: cfg.webOrigin, fetchImpl: ctx.fetchImpl });
      const login = await fresh.request('POST', '/api/v1/auth/login', { email: `smoke-erase-a-${suffix}@example.com`, password: pw });
      check(login.status === 401 || login.status === 409, `login answered ${login.status}`);
      return `me ${me.status}, login ${login.status}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
