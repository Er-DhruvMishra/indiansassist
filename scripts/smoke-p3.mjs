#!/usr/bin/env node
// IndiansAssist Phase C smoke (docs/specs/phase-c-contracts.md section 15.4) against a running api, server side
// only: a Node ws client plays the native agent (no Origin, `client.kind: 'native'`), no browser and no media.
//
//   SIGNUP_PLAN_TIER=p3_portable pnpm --filter @indiansassist/api start    # the throwaway org needs a P3 plan
//   pnpm smoke:p3                                                           # API_URL defaults to http://localhost:4000
//
// Env: API_URL, WEB_ORIGIN, SIGNAL_URL, SMOKE_TIMEOUT_MS (as smoke.mjs). The download step needs AGENT_DIST_DIR
// with a manifest on the api, or (dev) the AGENT_DEV_STUB placeholder the api serves when it has none. Prints
// PASS / FAIL / SKIP per step; exits 1 on any failure.

import { pathToFileURL } from 'node:url';
import { ApiClient } from './smoke/http.mjs';
import { Runner } from './smoke/runner.mjs';
import { p3Steps } from './smoke/flow-p3.mjs';
import { p3AgentSteps } from './smoke/flow-p3-agent.mjs';

export async function runSmokeP3(opts = {}) {
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
    await p3Steps(run, ctx);
    await p3AgentSteps(run, ctx);
  } finally {
    for (const s of ctx.sockets) s.close();
  }
  run.log(`\nsmoke p3: ${run.summary()} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const timeout = Number(env.SMOKE_TIMEOUT_MS);
  runSmokeP3({
    apiUrl: env.API_URL || 'http://localhost:4000',
    webOrigin: env.WEB_ORIGIN || undefined,
    signalUrl: env.SIGNAL_URL || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
  })
    .then((run) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke p3 crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
