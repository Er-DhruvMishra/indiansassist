// @vitest-environment jsdom
/**
 * The bar's e2e-only hook (content/indicator.ts `mirrorBarForE2e`, contract 13.2): the closed shadow root's state is
 * mirrored into `data-ia-e2e-*` host attributes **only** in the `IA_E2E=1` build. Asserted here: the hook writes
 * what the Playwright specs read; an ordinary build (vitest compiles with `__IA_E2E__ = false`) sets no such
 * attribute; a production build refuses `IA_E2E=1`; and the production `content.js` bundle does not even contain
 * the hook (built for real with Vite), while the e2e bundle does.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildEnv, defines, ROOT } from '../scripts/env.mjs';
import { DEFAULT_BAR, IndicatorBar, mirrorBarForE2e } from '../src/content/indicator';

const PROD_ORIGINS = 'in-mum=https://in.indiansassist.example';

function handlers() {
  return { onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onHide: vi.fn(), onPromptAnswer: vi.fn(), onCloseBackstage: vi.fn(), onHiddenTooLong: vi.fn() };
}

function e2eAttributes(host: Element): string[] {
  return host.getAttributeNames().filter((n) => n.startsWith('data-ia-e2e'));
}

afterEach(() => {
  document.documentElement.querySelectorAll('ia-indicator').forEach((n) => n.remove());
});

describe('bar e2e hook', () => {
  it('is off outside the e2e build: no data-ia-e2e-* attribute through mount, update, prompt, toast, pause', () => {
    const bar = new IndicatorBar(document, handlers());
    bar.mount({ technician: 'Asha', org: 'Acme', recording: true });
    bar.showPrompt('p1', 'Asha asks to see: a field');
    bar.toast('Technician opened a background tab: example.com');
    bar.update({ paused: true, revealed: true });
    expect(bar.textForTest()).toContain('Paused: not shared');
    expect(e2eAttributes(bar.host)).toEqual([]);
    bar.destroy();
  });

  it('mirrors bar text, prompts, toast and button centres when called (e2e build)', () => {
    const host = document.createElement('ia-indicator');
    const bar = document.createElement('div');
    bar.textContent = 'Shared with Asha (Acme)';
    const stop = document.createElement('button');
    stop.textContent = 'Stop sharing';
    bar.appendChild(stop);
    mirrorBarForE2e(host, bar, { ...DEFAULT_BAR, technician: 'Asha', org: 'Acme' }, ['Asha asks for: x', 'Asha asks to see: y'], 'Technician opened a background tab: example.com');
    expect(host.getAttribute('data-ia-e2e-bar')).toBe('Shared with Asha (Acme)');
    expect(host.getAttribute('data-ia-e2e-text')).toBe('Shared with Asha (Acme)Stop sharing');
    expect(host.getAttribute('data-ia-e2e-prompts')).toBe('Asha asks for: x | Asha asks to see: y');
    expect(host.getAttribute('data-ia-e2e-toast')).toBe('Technician opened a background tab: example.com');
    expect(JSON.parse(host.getAttribute('data-ia-e2e-buttons') ?? '[]')).toEqual([{ label: 'Stop sharing', x: 0, y: 0 }]);
    mirrorBarForE2e(host, bar, { ...DEFAULT_BAR, paused: true }, [], null);
    expect(host.getAttribute('data-ia-e2e-bar')).toBe('Paused: not shared');
    expect(host.hasAttribute('data-ia-e2e-prompts')).toBe(false);
    expect(host.hasAttribute('data-ia-e2e-toast')).toBe(false);
  });

  it('a production build for the public downloads page carries exactly its https origin', () => {
    const cfg = buildEnv({ IA_DEV: '0', VITE_REGION_ORIGINS: 'in-mum=https://api.indiansassist.com' });
    expect(cfg.dev).toBe(false);
    expect(cfg.regionOrigins).toEqual(['https://api.indiansassist.com']);
    expect(cfg.defaultApiOrigin).toBe('https://api.indiansassist.com');
    expect(() => buildEnv({ IA_DEV: '0', VITE_REGION_ORIGINS: 'in-mum=http://api.indiansassist.com' })).toThrow(/https/);
  });

  it('compiles the flag false in production builds and refuses IA_E2E=1 there', () => {
    expect(defines(buildEnv({ IA_DEV: '0', VITE_REGION_ORIGINS: PROD_ORIGINS })).__IA_E2E__).toBe('false');
    expect(() => buildEnv({ IA_DEV: '0', IA_E2E: '1', VITE_REGION_ORIGINS: PROD_ORIGINS })).toThrow(/IA_E2E=1 is for the dev e2e build only/);
    expect(defines(buildEnv({ IA_DEV: '1', IA_E2E: '1' })).__IA_E2E__).toBe('true');
  });

  describe('content.js bundle', () => {
    const out = mkdtempSync(join(tmpdir(), 'ia-ext-hook-'));
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    /** Builds content.js exactly as scripts/build.mjs pass 2 does, into a temp dir, with the given build env. */
    function buildContent(name: string, env: Record<string, string>): string {
      const dir = resolve(out, name);
      const script = "import { build } from 'vite'; await build({ configFile: 'vite.content.config.ts', mode: 'content', logLevel: 'error' });";
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        stdio: 'pipe',
        env: { ...process.env, IA_E2E: '', IA_DEV: '', VITE_REGION_ORIGINS: '', ...env, IA_OUT_DIR: dir },
      });
      return readFileSync(resolve(dir, 'content.js'), 'utf8');
    }

    it('the production bundle has no e2e hook; the e2e bundle has it', () => {
      const prod = buildContent('prod', { IA_DEV: '0', VITE_REGION_ORIGINS: PROD_ORIGINS });
      expect(prod).toContain('Stop sharing'); // it is the real capture bundle
      expect(prod).not.toContain('data-ia-e2e');
      const e2e = buildContent('e2e', { IA_DEV: '1', IA_E2E: '1' });
      expect(e2e).toContain('data-ia-e2e-');
    }, 60_000);
  });
});
