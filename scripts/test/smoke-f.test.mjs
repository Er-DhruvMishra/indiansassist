// The Phase F smoke runner (docs/specs/phase-f-contracts.md section 1.4): it picks up each stream's
// scripts/smoke/flow-f-<name>.mjs without being edited, reports a missing flow as "not built" (neither pass nor
// failure), and fails when a flow's step fails or the module is broken. No api is contacted: the flows here are fakes.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { F_FLOWS, flowPath, runSmokeF } from '../smoke-f.mjs';

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'ia-smoke-f-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('smoke-f runner', () => {
  it('lists the four stream flows and passes with none built', async () => {
    expect(F_FLOWS).toEqual(['fixes', 'mail', 'erasure', 'camera']);
    const lines = [];
    const { run, built, notBuilt } = await runSmokeF({ dir: tempDir(), log: (l) => lines.push(l) });
    expect(run.ok).toBe(true);
    expect(built).toEqual([]);
    expect(notBuilt).toEqual(F_FLOWS);
    expect(lines.join('\n')).toContain('not built yet');
  });

  it('runs a built flow with its own context, and a failing step fails the run', async () => {
    const dir = tempDir();
    writeFileSync(
      flowPath('mail', dir),
      `export async function flowSteps(run, ctx) {
        await run.step('mail: context', () => { if (!ctx.api || ctx.cfg.apiUrl !== 'http://api.test') throw new Error('bad ctx'); return 'ok'; });
      }`,
    );
    writeFileSync(flowPath('erasure', dir), `export async function flowSteps(run) { await run.step('erasure: fails', () => { throw new Error('boom'); }); }`);
    const one = await runSmokeF({ dir, flows: ['mail'], apiUrl: 'http://api.test/', log: () => undefined });
    expect(one.run.ok).toBe(true);
    expect(one.built).toEqual(['mail']);
    const both = await runSmokeF({ dir, flows: ['mail', 'erasure', 'camera'], apiUrl: 'http://api.test', log: () => undefined });
    expect(both.run.ok).toBe(false);
    expect(both.notBuilt).toEqual(['camera']);
  });

  it('a module without flowSteps fails, and an unknown flow name is refused', async () => {
    const dir = tempDir();
    writeFileSync(flowPath('fixes', dir), 'export const nothing = 1;');
    const r = await runSmokeF({ dir, flows: ['fixes'], log: () => undefined });
    expect(r.run.ok).toBe(false);
    await expect(runSmokeF({ dir, flows: ['billing'], log: () => undefined })).rejects.toThrow(/unknown Phase F flow/);
  });
});
