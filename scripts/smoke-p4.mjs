#!/usr/bin/env node
// IndiansAssist Phase D smoke (docs/specs/phase-d-contracts.md section 15.3) against a running api, server side only:
// Node ws clients play two installed services (/signal/device) and a desktop worker (/signal), no browser and no media.
//
//   SIGNUP_PLAN_TIER=p4_installed pnpm --filter @indiansassist/api start    # the throwaway org needs a P4 plan
//   pnpm smoke:p4                                                          # API_URL defaults to http://localhost:4000
//
// Env: API_URL, WEB_ORIGIN, SIGNAL_URL, SMOKE_TIMEOUT_MS (as smoke.mjs). Prints PASS / FAIL / SKIP per step; exits 1
// on any failure.

import { pathToFileURL } from 'node:url';
import { ApiClient } from './smoke/http.mjs';
import { Runner } from './smoke/runner.mjs';
import { p4Steps } from './smoke/flow-p4.mjs';

export async function runSmokeP4(opts = {}) {
  const run = new Runner({ log: opts.log });
  const apiUrl = (opts.apiUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
  const ctx = {
    cfg: {
      apiUrl,
      webOrigin: opts.webOrigin ?? null,
      signalUrl: opts.signalUrl ?? null,
      signalUrlOverride: opts.signalUrl ?? null,
      timeoutMs: opts.timeoutMs ?? 5000,
    },
    api: new ApiClient(apiUrl, { origin: opts.webOrigin ?? null, fetchImpl: opts.fetchImpl }),
    fetchImpl: opts.fetchImpl,
    state: {},
    sockets: [],
  };
  try {
    await p4Steps(run, ctx);
  } finally {
    for (const s of ctx.sockets) s.close();
  }
  run.log(`\nsmoke p4: ${run.summary()} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const timeout = Number(env.SMOKE_TIMEOUT_MS);
  runSmokeP4({
    apiUrl: env.API_URL || 'http://localhost:4000',
    webOrigin: env.WEB_ORIGIN || undefined,
    signalUrl: env.SIGNAL_URL || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
  })
    .then((run) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke p4 crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
