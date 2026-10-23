// Wipes ./data/e2e-ext (PGlite + storage) so every extension e2e run starts from an empty database.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'data', 'e2e-ext');
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(dir, { recursive: true });
console.log(`e2e: reset ${dir}`);
