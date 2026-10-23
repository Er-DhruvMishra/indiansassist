// Pass 2 (section 9.5): `content.js` (capture, injected only during a session) and `bridge.js` (join page
// carrier B) as single-file IIFEs; content scripts cannot be ES modules. `--mode bridge` picks the bridge.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { asciiPlugin } from './scripts/ascii.mjs';
import { buildEnv, defines } from './scripts/env.mjs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const cfg = buildEnv();

export default defineConfig(({ mode }) => {
  const name = mode === 'bridge' ? 'bridge' : 'content';
  return {
    publicDir: false,
    plugins: [asciiPlugin()],
    define: { ...defines(cfg), 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      outDir: here('./dist'),
      emptyOutDir: false,
      target: 'es2022',
      sourcemap: false,
      lib: {
        entry: here(name === 'bridge' ? './src/content/bridge.ts' : './src/content/index.ts'),
        formats: ['iife'],
        name: name === 'bridge' ? 'iaBridge' : 'iaCapture',
        fileName: () => `${name}.js`,
      },
    },
  };
});
