// Wipes ./data/e2e-p4 (PGlite + storage) so every Package 4 Playwright run starts from an empty database.
// Package 4 uses its own data dir (separate from Package 1's ./data/e2e and Package 3's ./data/e2e-p3) so the
// three suites never share state.
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = resolve(root, 'data', 'e2e-p4');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(dir, { recursive: true });
console.log(`e2e-p4: reset ${dir}`);
