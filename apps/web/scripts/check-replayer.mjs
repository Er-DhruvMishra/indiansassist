/**
 * Gate for dist/replayer.html (Phase B 10.2, 13.5): one inline script whose sha256 equals the meta CSP
 * `script-src` hash, no `src=` / `href=` network reference anywhere outside the script, no `'self'` in the CSP.
 * Usage: node scripts/check-replayer.mjs [path]  (default dist/replayer.html). Exits 1 on any failure.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkReplayerHtml(html) {
  const errors = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1) errors.push(`expected exactly one <script>, found ${scripts.length}`);
  const [whole, attrs = '', body = ''] = scripts[0] ?? [];
  if (attrs.trim() !== '') errors.push(`the script element must carry no attributes (found "${attrs.trim()}")`);
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i.exec(html)?.[1];
  if (!csp) errors.push('missing meta Content-Security-Policy');
  else {
    if (csp.includes("'self'")) errors.push("CSP must not contain 'self'");
    const want = createHash('sha256').update(body, 'utf8').digest('base64');
    const got = /script-src 'sha256-([^']+)'/.exec(csp)?.[1];
    if (got !== want) errors.push(`CSP script hash ${got} does not match the inline script (${want})`);
    for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'"])
      if (!csp.includes(d)) errors.push(`CSP lacks ${d}`);
  }
  const outside = whole ? html.replace(whole, '') : html;
  if (/\s(src|href|srcset)\s*=/i.test(outside)) errors.push('an element outside the script references a URL (src / href)');
  if (/<link\b/i.test(outside)) errors.push('a <link> element is present');
  return errors;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const file = resolve(dirname(self), '..', process.argv[2] ?? 'dist/replayer.html');
  const errors = checkReplayerHtml(readFileSync(file, 'utf8'));
  if (errors.length) {
    for (const e of errors) console.error(`replayer.html: ${e}`);
    process.exit(1);
  }
  console.log(`replayer.html ok (${file})`);
}
