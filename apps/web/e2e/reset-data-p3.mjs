// Wipes ./data/e2e-p3 (PGlite + storage) so every Package 3 Playwright run starts from an empty database.
// Package 3 uses its own data dir (separate from Package 1's ./data/e2e) so the two suites never share state.
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = resolve(root, 'data', 'e2e-p3');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(dir, { recursive: true });
console.log(`e2e-p3: reset ${dir}`);
