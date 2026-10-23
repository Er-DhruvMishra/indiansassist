/**
 * Builds `dist/replayer.html` (Phase B 10.2): `src/replayer/main.ts` (rrweb replay + the section 12.3 sanitiser)
 * as one IIFE, inlined with its CSS into a self-contained HTML file with no `src` / `href` network reference and
 * a meta CSP whose `script-src` is the sha256 of the inline script. The page runs in an opaque-origin sandboxed
 * frame, so it must not load anything from `/assets/`. Runs after the SPA build (`emptyOutDir: false`).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/** Makes script text safe to embed in an HTML `<script>` element without changing what it does. */
export function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

export function replayerCsp(scriptHash: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

function inlineReplayer(): Plugin {
  return {
    name: 'ia-inline-replayer',
    apply: 'build',
    generateBundle(_opts, bundle) {
      // rrweb's stylesheet is imported with `?inline` and inserted by the script itself (style-src 'unsafe-inline').
      let code = '';
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk') code += item.code;
        else if (!name.endsWith('.css')) continue;
        delete bundle[name];
      }
      if (!code) this.error('replayer bundle produced no script');
      const script = escapeInlineScript(code);
      const hash = createHash('sha256').update(script, 'utf8').digest('base64');
      const template = readFileSync(resolve(here, 'replayer.html'), 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
      const html = template
        .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${replayerCsp(hash)}" />`)
        .replace(/<script type="module" src="[^"]*"><\/script>/, () => `<script>${script}</script>`);
      if (/\s(src|href)=/i.test(html.replace(/<script>[\s\S]*<\/script>/, ''))) this.error('replayer.html must not reference external resources');
      this.emitFile({ type: 'asset', fileName: 'replayer.html', source: html });
    },
  };
}

export default defineConfig({
  plugins: [inlineReplayer()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    copyPublicDir: false,
    lib: { entry: resolve(here, 'src/replayer/main.ts'), formats: ['iife'], name: 'IaReplayer', fileName: () => 'replayer.js' },
  },
});
