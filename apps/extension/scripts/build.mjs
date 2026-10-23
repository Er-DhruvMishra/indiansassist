// Builds apps/extension/dist (section 9.5): pass 1 pages + worker, pass 2 the two IIFE content scripts, then
// dist/manifest.json, icons and the managed schema. `--watch` rebuilds on change.
import { build } from 'vite';
import { resolve } from 'node:path';
import { ROOT } from './env.mjs';
import { writeManifest } from './manifest.mjs';

const watch = process.argv.includes('--watch') ? {} : null;
const logLevel = process.env.IA_BUILD_VERBOSE ? 'info' : 'warn';

await build({ configFile: resolve(ROOT, 'vite.config.ts'), logLevel, build: { watch } });
for (const mode of ['content', 'bridge']) {
  await build({ configFile: resolve(ROOT, 'vite.content.config.ts'), mode, logLevel, build: { watch } });
}
const manifest = writeManifest();
console.log(`extension ${manifest.version} built to ${resolve(ROOT, 'dist')} (externally_connectable: ${manifest.externally_connectable.matches.join(', ')})`);
