// The Phase E smoke runner (docs/specs/phase-e-contracts.md section 1.4): it picks up each stream's
// scripts/smoke/flow-e-<name>.mjs without being edited, reports a missing flow as "not built" (neither pass nor
// failure), and fails when a flow's step fails or the module is broken. No api is contacted: the flows here are fakes.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { E_FLOWS, flowPath, runSmokeE } from '../smoke-e.mjs';

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'ia-smoke-e-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('smoke-e runner', () => {
  it('lists the four stream flows and passes with none built', async () => {
    expect(E_FLOWS).toEqual(['sso', 'tickets', 'ai', 'residency']);
    const lines = [];
    const { run, built, notBuilt } = await runSmokeE({ dir: tempDir(), log: (l) => lines.push(l) });
    expect(run.ok).toBe(true);
    expect(built).toEqual([]);
    expect(notBuilt).toEqual(E_FLOWS);
    expect(lines.join('\n')).toContain('not built yet');
  });

  it('runs a built flow with its own context, and a failing step fails the run', async () => {
    const dir = tempDir();
    writeFileSync(
      flowPath('ai', dir),
      `export async function flowSteps(run, ctx) {
        await run.step('ai: context', () => { if (!ctx.api || ctx.cfg.apiUrl !== 'http://api.test') throw new Error('bad ctx'); return 'ok'; });
      }`,
    );
    writeFileSync(flowPath('tickets', dir), `export async function flowSteps(run) { await run.step('tickets: fails', () => { throw new Error('boom'); }); }`);
    const one = await runSmokeE({ dir, flows: ['ai'], apiUrl: 'http://api.test/', log: () => undefined });
    expect(one.run.ok).toBe(true);
    expect(one.built).toEqual(['ai']);
    const both = await runSmokeE({ dir, flows: ['ai', 'tickets', 'sso'], apiUrl: 'http://api.test', log: () => undefined });
    expect(both.run.ok).toBe(false);
    expect(both.notBuilt).toEqual(['sso']);
  });

  it('a module without flowSteps fails, and an unknown flow name is refused', async () => {
    const dir = tempDir();
    writeFileSync(flowPath('sso', dir), 'export const nothing = 1;');
    const r = await runSmokeE({ dir, flows: ['sso'], log: () => undefined });
    expect(r.run.ok).toBe(false);
    await expect(runSmokeE({ dir, flows: ['billing'], log: () => undefined })).rejects.toThrow(/unknown Phase E flow/);
  });
});
