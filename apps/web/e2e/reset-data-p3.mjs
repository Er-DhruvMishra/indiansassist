// Wipes ./data/e2e-p3 (PGlite + storage) so every Package 3 Playwright run starts from an empty database.
// Package 3 uses its own data dir (separate from Package 1's ./data/e2e) so the two suites never share state.
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// E2E_DATA_DIR (relative to the repo root; phase-f-contracts section 3.5) lets parallel P3 runs keep separate
// databases; default ./data/e2e-p3. The reset-data.mjs containment check: never outside ./data.
const dir = resolve(root, process.env.E2E_DATA_DIR || 'data/e2e-p3');
if (!dir.startsWith(resolve(root, 'data'))) throw new Error(`e2e-p3: refusing to reset ${dir}, outside ./data`);
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(dir, { recursive: true });
console.log(`e2e-p3: reset ${dir}`);
