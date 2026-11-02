#!/usr/bin/env node
// IndiansAssist Phase F smoke runner (docs/specs/phase-f-contracts.md sections 1.4, 15.2-15.5) against a running
// api, server side only. The foundation (F0) lands the runner; each stream adds its flow module, which the runner
// picks up without being edited again:
//
//   scripts/smoke/flow-f-fixes.mjs    (stream fixes)
//   scripts/smoke/flow-f-mail.mjs     (stream mail; its fake SMTP, scripts/smoke/fake-smtp.mjs, runs in this process)
//   scripts/smoke/flow-f-erasure.mjs  (stream erasure)
//   scripts/smoke/flow-f-camera.mjs   (stream camera)
//
// A flow module exports `async function flowSteps(run, ctx)` (ctx: { cfg, api, fetchImpl, state, sockets }); its
// fakes run in this process. A flow that is not built yet is listed as "not built" and is neither a pass nor a
// failure.
//
//   pnpm smoke:f                            # API_URL defaults to http://localhost:4000
//   SMOKE_F_FLOWS=mail,camera pnpm smoke:f  # run a subset
//
// Env: API_URL, WEB_ORIGIN, SIGNAL_URL, SMOKE_TIMEOUT_MS (as smoke.mjs), SMOKE_F_FLOWS. Exits 1 on any failure.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiClient } from './smoke/http.mjs';
import { Runner } from './smoke/runner.mjs';

export const F_FLOWS = ['fixes', 'mail', 'erasure', 'camera'];
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'smoke');

/** The flow module path of a stream (`scripts/smoke/flow-f-<name>.mjs`). */
export function flowPath(name, dir = DIR) {
  return join(dir, `flow-f-${name}.mjs`);
}

/**
 * Runs every selected Phase F flow that exists; returns `{ run, built, notBuilt }`.
 * @param {{ apiUrl?: string, webOrigin?: string, signalUrl?: string, timeoutMs?: number, flows?: string[],
 *           dir?: string, log?: (l: string) => void, fetchImpl?: typeof fetch }} [opts]
 */
export async function runSmokeF(opts = {}) {
  const run = new Runner({ log: opts.log });
  const apiUrl = (opts.apiUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
  const selected = opts.flows && opts.flows.length > 0 ? opts.flows : F_FLOWS;
  for (const f of selected) if (!F_FLOWS.includes(f)) throw new Error(`unknown Phase F flow ${f} (one of ${F_FLOWS.join(', ')})`);
  const built = [];
  const notBuilt = [];
  run.log(`smoke f: ${apiUrl}`);
  for (const name of selected) {
    const path = flowPath(name, opts.dir);
    if (!existsSync(path)) {
      notBuilt.push(name);
      run.log(`----  ${name}: not built yet (${path})`);
      continue;
    }
    built.push(name);
    const ctx = {
      cfg: { apiUrl, webOrigin: opts.webOrigin ?? null, signalUrl: opts.signalUrl ?? null, timeoutMs: opts.timeoutMs ?? 5000 },
      api: new ApiClient(apiUrl, { origin: opts.webOrigin ?? null, fetchImpl: opts.fetchImpl }),
      fetchImpl: opts.fetchImpl,
      state: {},
      sockets: [],
    };
    try {
      const mod = await import(pathToFileURL(path).href);
      if (typeof mod.flowSteps !== 'function') throw new Error(`${path} does not export flowSteps(run, ctx)`);
      await mod.flowSteps(run, ctx);
    } catch (err) {
      await run.step(`${name}: flow module`, () => {
        throw err;
      });
    } finally {
      for (const s of ctx.sockets) s.close?.();
    }
  }
  run.log(`\nsmoke f: ${run.summary()}; flows run: ${built.join(', ') || 'none'}; not built: ${notBuilt.join(', ') || 'none'} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return { run, built, notBuilt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const timeout = Number(env.SMOKE_TIMEOUT_MS);
  runSmokeF({
    apiUrl: env.API_URL || 'http://localhost:4000',
    webOrigin: env.WEB_ORIGIN || undefined,
    signalUrl: env.SIGNAL_URL || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
    flows: (env.SMOKE_F_FLOWS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  })
    .then(({ run }) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke f crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
