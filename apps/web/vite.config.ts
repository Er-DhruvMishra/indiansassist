// Vite config for @indiansassist/web. Tailwind CSS v4 is wired through its official Vite plugin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Phase F section 7.6a: emits `/sw.js` (the app-shell service worker, `src/sw.ts`) with this build's id and its
 * hashed `/assets/*` list. A classic script (CommonJS transpile with a local `exports`), so every browser that runs
 * service workers can register it without `type: 'module'`. Build only; the dev server never serves a worker.
 */
export function shellWorker(): Plugin {
  return {
    name: 'ia-shell-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/') && !f.endsWith('.map'))
        .map((f) => `/${f}`)
        .sort();
      const buildId = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16);
      const source = readFileSync(resolve(here, 'src/sw.ts'), 'utf8');
      const js = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, removeComments: false, sourceMap: false },
        fileName: 'sw.ts',
      }).outputText;
      const code = `/* IndiansAssist app-shell worker, build ${buildId} (generated from src/sw.ts) */\n'use strict';\nvar exports = {};\nconst IA_SW_BUILD = ${JSON.stringify(buildId)};\nconst IA_SW_ASSETS = ${JSON.stringify(assets)};\n${js.replace(/^"use strict";\s*/, '')}`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    },
  };
}

/**
 * The Playwright suites run the dev server with `IA_E2E_STATIC=1`: no file watcher and no HMR, so a build, a typecheck
 * or an edit elsewhere in the repository cannot hot-update or reload a page in the middle of a test (a hot update
 * re-runs the effects of the updated components, which tears down a live camera or session controller).
 */
const e2eStatic = process.env.IA_E2E_STATIC === '1';

export default defineConfig({
  plugins: [react(), tailwindcss(), shellWorker()],
  server: { port: 5173, strictPort: true, ...(e2eStatic ? { hmr: false, watch: null } : {}) },
  preview: { port: 5173 },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
