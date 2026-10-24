/**
 * Builds the extension for the e2e into apps/extension/dist-e2e (IA_E2E=1, dev origins, REST and the signal
 * socket pointed at the e2e api port, the per-run manifest key of extension-key.ts), so `dist/` stays the normal
 * dev build. packages/shared must be built.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eExtensionIdentity } from './extension-key';

export const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const E2E_DIST = resolve(EXT_ROOT, 'dist-e2e');

export default function globalSetup(): void {
  const apiPort = process.env.E2E_API_PORT || '4000';
  execFileSync(process.execPath, [resolve(EXT_ROOT, 'scripts/build.mjs')], {
    cwd: EXT_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      IA_OUT_DIR: 'dist-e2e',
      IA_E2E: '1',
      IA_DEV: '1',
      VITE_REGION_ORIGINS: '',
      VITE_API_URL: `http://localhost:${apiPort}`,
      EXTENSION_KEY: e2eExtensionIdentity().key,
    },
  });
}
