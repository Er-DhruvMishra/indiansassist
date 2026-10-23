#!/usr/bin/env node
// IndiansAssist Phase B (Package 2) smoke test against a running api, server side only, no browser
// (docs/specs/phase-b-contracts.md section 13.3). The 26-step `pnpm smoke` stays the default gate; this is
// `pnpm smoke:p2`, also run by `SMOKE_P2=1 pnpm smoke` after the Phase A steps.
//
//   pnpm smoke:p2                                  # API_URL defaults to http://localhost:4000
//
// Env:
//   API_URL             api origin (dev: http://localhost:4000)
//   WEB_ORIGIN          Origin of the Assist socket and REST calls (default: origin of well-known `join`)
//   SIGNAL_URL          override the WebSocket URL
//   SMOKE_EXTENSION_ID  32-char id used for `Origin: chrome-extension://<id>`; must be listed in the api's
//                       EXTENSION_IDS when that is set (dev with EXTENSION_IDS empty accepts any id)
//   SMOKE_TIMEOUT_MS    per-wait timeout (default 5000)
//
// Needs packages/shared built. Signs up a throwaway org (its plan tier comes from SIGNUP_PLAN_TIER, default
// p2_extension), then walks the P2 flow of flow-p2.mjs and verifies the session chain. Exits 1 on any failure.

import { pathToFileURL } from 'node:url';
import { EXTENSION_ID_PLACEHOLDER_FALLBACK, p2Ctx } from './smoke/p2-ctx.mjs';
import { loadShared } from './smoke/shared.mjs';
import { Runner } from './smoke/runner.mjs';
import { p2SetupSteps, p2SignalSteps } from './smoke/flow-p2.mjs';
import { p2AuditSteps } from './smoke/flow-p2-audit.mjs';

/**
 * Runs the P2 flow; returns the Runner. With `run` given (SMOKE_P2=1 from smoke.mjs) the steps are appended to it.
 * @param {{ apiUrl?: string, webOrigin?: string, signalUrl?: string, extensionId?: string, timeoutMs?: number,
 *           log?: (l: string) => void, fetchImpl?: typeof fetch, run?: Runner }} [opts]
 */
export async function runSmokeP2(opts = {}) {
  const run = opts.run ?? new Runner({ log: opts.log });
  const ctx = p2Ctx({ ...opts, extensionId: opts.extensionId ?? EXTENSION_ID_PLACEHOLDER_FALLBACK });
  run.log(`smoke p2: ${ctx.cfg.apiUrl} (extension origin ${ctx.cfg.extensionOrigin})`);
  try {
    await run.step('P2: load @indiansassist/shared (built package)', async () => {
      ctx.shared = await loadShared();
      if (typeof ctx.shared.mirrorRelaySchema !== 'object') throw new Error('packages/shared/dist predates Phase B; rebuild it');
    });
    await p2SetupSteps(run, ctx);
    await p2SignalSteps(run, ctx);
    await p2AuditSteps(run, ctx);
  } finally {
    for (const s of ctx.sockets) s.close();
  }
  if (!opts.run) run.log(`\nsmoke p2: ${run.summary()} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const timeout = Number(env.SMOKE_TIMEOUT_MS);
  runSmokeP2({
    apiUrl: env.API_URL || 'http://localhost:4000',
    webOrigin: env.WEB_ORIGIN || undefined,
    signalUrl: env.SIGNAL_URL || undefined,
    extensionId: env.SMOKE_EXTENSION_ID || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
  })
    .then((run) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke p2 crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
