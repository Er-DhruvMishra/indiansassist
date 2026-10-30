/**
 * Runs scripts/smoke-p3.mjs (the `pnpm smoke:p3` flow) against this api in-process, with a P3 signup plan and the
 * dev placeholder build, so the P3 smoke is itself tested against the real server.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen, makeApp, type TestApp } from './helpers.js';

type Result = { name: string; status: string; detail: string };
type SmokeRun = { ok: boolean; results: Result[] };
type RunSmokeP3 = (opts: Record<string, unknown>) => Promise<SmokeRun>;

let t: TestApp;
let apiUrl: string;
let runSmokeP3: RunSmokeP3;

beforeAll(async () => {
  const stub = join(mkdtempSync(join(tmpdir(), 'ia-stub-')), 'agent-dev-stub.bin');
  t = await makeApp({ SIGNUP_PLAN_TIER: 'p3_portable', AGENT_DEV_STUB: stub }, { tickMs: 50 });
  apiUrl = (await listen(t.app)).replace(/^ws/, 'http').replace(/\/signal$/, '');
  // The download grant URL is built from API_ORIGIN: point it at this listener.
  t.ctx.config.apiOrigin = apiUrl;
  const file = resolve(t.ctx.config.repoRoot, 'scripts', 'smoke-p3.mjs');
  runSmokeP3 = ((await import(pathToFileURL(file).href)) as { runSmokeP3: RunSmokeP3 }).runSmokeP3;
});
afterAll(async () => {
  await t.close();
});

describe('pnpm smoke:p3 against the real api', () => {
  it('passes every step', async () => {
    const lines: string[] = [];
    const signalUrl = `${apiUrl.replace(/^http/, 'ws')}/signal`;
    const run = await runSmokeP3({ apiUrl, signalUrl, webOrigin: 'http://localhost:5173', timeoutMs: 5000, log: (l: string) => lines.push(l) });
    const failed = run.results.filter((r) => r.status !== 'PASS');
    expect(failed, lines.join('\n')).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.results.length).toBeGreaterThanOrEqual(12);
  });
});
