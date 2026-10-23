/**
 * Runs scripts/smoke-p2.mjs (the `pnpm smoke:p2` flow) against this api in-process, so the P2 smoke is itself
 * tested against the real server and not only against a running dev stack.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen, makeApp, type TestApp } from './helpers.js';

type Result = { name: string; status: string; detail: string };
type SmokeRun = { ok: boolean; results: Result[] };
type RunSmokeP2 = (opts: Record<string, unknown>) => Promise<SmokeRun>;

let t: TestApp;
let apiUrl: string;
let runSmokeP2: RunSmokeP2;

beforeAll(async () => {
  t = await makeApp({}, { tickMs: 50 });
  apiUrl = (await listen(t.app)).replace(/^ws/, 'http').replace(/\/signal$/, '');
  const file = resolve(t.ctx.config.repoRoot, 'scripts', 'smoke-p2.mjs');
  runSmokeP2 = ((await import(pathToFileURL(file).href)) as { runSmokeP2: RunSmokeP2 }).runSmokeP2;
});
afterAll(async () => {
  await t.close();
});

describe('pnpm smoke:p2 against the real api', () => {
  it('passes every step', async () => {
    const lines: string[] = [];
    const signalUrl = `${apiUrl.replace(/^http/, 'ws')}/signal`;
    const run = await runSmokeP2({ apiUrl, signalUrl, webOrigin: 'http://localhost:5173', timeoutMs: 5000, log: (l: string) => lines.push(l) });
    const failed = run.results.filter((r) => r.status !== 'PASS');
    expect(failed, lines.join('\n')).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.results.length).toBeGreaterThanOrEqual(13);
  });
});
