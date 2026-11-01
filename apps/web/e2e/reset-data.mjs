// Wipes ./data/e2e (PGlite + recording storage) so every Playwright run starts from an empty database.
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// E2E_DATA_DIR (relative to the repo root) lets parallel suites keep separate databases; default ./data/e2e.
const dir = resolve(root, process.env.E2E_DATA_DIR || 'data/e2e');
if (!dir.startsWith(resolve(root, 'data'))) throw new Error(`e2e: refusing to reset ${dir}, outside ./data`);
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(dir, { recursive: true });
console.log(`e2e: reset ${dir}`);
