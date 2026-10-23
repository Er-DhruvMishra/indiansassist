// Pass 1 (section 9.5): the extension pages (side panel, popup, consent, options, offscreen) and the service
// worker as ES modules. Pass 2 (`vite.content.config.ts`) builds the two content scripts as IIFEs.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { asciiPlugin } from './scripts/ascii.mjs';
import { buildEnv, defines } from './scripts/env.mjs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const cfg = buildEnv();

export default defineConfig({
  root: here('./src/pages'),
  base: './',
  publicDir: false,
  define: defines(cfg),
  plugins: [asciiPlugin()],
  build: {
    outDir: here('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        sidepanel: here('./src/pages/sidepanel.html'),
        popup: here('./src/pages/popup.html'),
        consent: here('./src/pages/consent.html'),
        options: here('./src/pages/options.html'),
        offscreen: here('./src/pages/offscreen.html'),
        background: here('./src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
