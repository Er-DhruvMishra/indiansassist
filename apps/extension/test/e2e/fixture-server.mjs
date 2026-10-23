// Static fixture server for the extension e2e (docs/specs/phase-b-contracts.md section 13.2): serves
// apps/extension/test/fixtures on :4175 (E2E_FIXTURE_PORT). Only plain files, no directory listing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const port = Number(process.env.E2E_FIXTURE_PORT || 4175);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const rel = normalize(path === '/' ? '/form.html' : path).replace(/^[/\\]+/, '');
  const file = join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(port, () => console.log(`fixtures on http://localhost:${port}`));
