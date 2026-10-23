#!/usr/bin/env node
// IndiansAssist end-to-end smoke test against a running api (contracts sections 3, 5, 6, 7).
//
//   pnpm smoke                                   # API_URL defaults to http://localhost:4000
//   API_URL=https://in.example.com pnpm smoke    # through nginx (WEB_ORIGIN === API_ORIGIN)
//
// Env:
//   API_URL           api origin (dev: http://localhost:4000; production: the region's https origin)
//   WEB_ORIGIN        Origin header for CSRF / WS checks (default: origin of well-known `join`)
//   SIGNAL_URL        override the WebSocket URL (default: well-known `signal`, PublicToken.signalUrl for the Desk)
//   SMOKE_TIMEOUT_MS  per-wait timeout (default 5000)
//   SMOKE_P2=1        also run the Phase B block (scripts/smoke-p2.mjs; `pnpm smoke:p2` runs it alone)
// Self-signed TLS: set NODE_EXTRA_CA_CERTS=infra/certs/fullchain.pem (never disable verification in production).
//
// Signs up a throwaway org, logs out and in, creates a one_time p1_browser token, verifies its signature with
// the published key, looks it up publicly, walks the Assist / Desk signaling flow, then fetches the session
// audit and verifies it with @indiansassist/shared (packages/shared must be built). Prints PASS / FAIL / SKIP
// per step and exits 1 on any failure. Dependencies: `ws` and Node built-ins only.

import { pathToFileURL } from 'node:url';
import { ApiClient } from './smoke/http.mjs';
import { loadShared } from './smoke/shared.mjs';
import { Runner } from './smoke/runner.mjs';
import { restSteps, tokenUsedStep } from './smoke/flow-rest.mjs';
import { signalSteps } from './smoke/flow-signal.mjs';
import { auditSteps } from './smoke/flow-audit.mjs';
import { runSmokeP2 } from './smoke-p2.mjs';

/**
 * Runs the whole flow. Returns the Runner (results, ok, summary()).
 * With `p2` (SMOKE_P2=1) the Phase B block of smoke-p2.mjs runs after the Phase A steps, on its own throwaway org.
 * @param {{ apiUrl?: string, webOrigin?: string, signalUrl?: string, timeoutMs?: number, log?: (l: string) => void, fetchImpl?: typeof fetch, p2?: boolean, extensionId?: string }} [opts]
 */
export async function runSmoke(opts = {}) {
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
    shared: null,
    state: {},
    sockets: [],
  };
  run.log(`smoke: ${apiUrl}`);
  try {
    await run.step('load @indiansassist/shared (built package)', async () => {
      ctx.shared = await loadShared();
    });
    await restSteps(run, ctx);
    await signalSteps(run, ctx);
    await auditSteps(run, ctx);
    await tokenUsedStep(run, ctx);
  } finally {
    for (const s of ctx.sockets) s.close();
  }
  if (opts.p2) {
    await runSmokeP2({
      run,
      apiUrl,
      ...(opts.webOrigin ? { webOrigin: opts.webOrigin } : {}),
      ...(opts.signalUrl ? { signalUrl: opts.signalUrl } : {}),
      ...(opts.extensionId ? { extensionId: opts.extensionId } : {}),
      timeoutMs: ctx.cfg.timeoutMs,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }
  run.log(`\nsmoke: ${run.summary()} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const timeout = Number(env.SMOKE_TIMEOUT_MS);
  runSmoke({
    apiUrl: env.API_URL || 'http://localhost:4000',
    webOrigin: env.WEB_ORIGIN || undefined,
    signalUrl: env.SIGNAL_URL || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
    p2: env.SMOKE_P2 === '1',
    extensionId: env.SMOKE_EXTENSION_ID || undefined,
  })
    .then((run) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
