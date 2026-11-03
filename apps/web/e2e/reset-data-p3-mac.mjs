// Wipes the e2e:p3:mac data dir (E2E_DATA_DIR, default ./data/e2e-mac) so every run starts from an empty
// database. Refuses anything outside ./data/.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = resolve(root, process.env.E2E_DATA_DIR || './data/e2e-mac');
const rel = relative(resolve(root, 'data'), dir);
if (!rel || rel.startsWith('..') || resolve(root, 'data', rel) !== dir) {
  console.error(`e2e-p3-mac: refusing to reset ${dir} (not under ./data)`);
  process.exit(2);
}
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(dir, { recursive: true });
console.log(`e2e-p3-mac: reset ${dir}`);
