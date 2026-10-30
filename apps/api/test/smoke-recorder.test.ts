/**
 * Runs scripts/smoke-recorder.mjs (`pnpm smoke:recorder`) against this api in-process with a P3 signup plan, so the
 * A.2 steps and the Phase C recorder cases (native Desk, hand-over pause / re-assign) are tested on the real server.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen, makeApp, type TestApp } from './helpers.js';

type SmokeRun = { ok: boolean; results: { name: string; status: string; detail: string }[] };
type RunSmokeRecorder = (opts: Record<string, unknown>) => Promise<SmokeRun>;

const TOKEN = 'recorder-smoke-token-0123456789abcdef0123';
let t: TestApp;
let apiUrl: string;
let runSmokeRecorder: RunSmokeRecorder;

beforeAll(async () => {
  t = await makeApp({ SIGNUP_PLAN_TIER: 'p3_portable', RECORDER_TOKEN: TOKEN }, { tickMs: 50 });
  apiUrl = (await listen(t.app)).replace(/^ws/, 'http').replace(/\/signal$/, '');
  const file = resolve(t.ctx.config.repoRoot, 'scripts', 'smoke-recorder.mjs');
  runSmokeRecorder = ((await import(pathToFileURL(file).href)) as { runSmokeRecorder: RunSmokeRecorder }).runSmokeRecorder;
});
afterAll(async () => {
  await t.close();
});

describe('pnpm smoke:recorder against the real api (P3 plan)', () => {
  it('passes the A.2 steps and the P3 cases', async () => {
    const lines: string[] = [];
    const signalUrl = `${apiUrl.replace(/^http/, 'ws')}/signal`;
    const run = await runSmokeRecorder({ apiUrl, signalUrl, webOrigin: 'http://localhost:5173', recorderToken: TOKEN, timeoutMs: 5000, log: (l: string) => lines.push(l) });
    expect(run.results.filter((r) => r.status !== 'PASS'), lines.join('\n')).toEqual([]);
    expect(run.results.length).toBe(16);
  });
});
