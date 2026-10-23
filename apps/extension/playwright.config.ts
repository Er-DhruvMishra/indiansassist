/**
 * Playwright config for the Package 2 extension e2e (docs/specs/phase-b-contracts.md section 13.2).
 * Global setup builds the extension into dist-e2e; the web servers are the api on a fresh PGlite under
 * ./data/e2e-ext (rate limits off), the Vite dev server (:5173, the origin the dev extension build trusts) and the
 * fixture server (:4175). The spec launches its own browsers: the Desk is a persistent Chromium context with the
 * unpacked extension, the Assist an ordinary Chromium. Run from the repo root with `pnpm e2e:ext`.
 * `E2E_API_PORT=4100` moves the api when :4000 is taken.
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const apiPort = process.env.E2E_API_PORT || '4000';
const apiUrl = `http://localhost:${apiPort}`;
const fixturePort = process.env.E2E_FIXTURE_PORT || '4175';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './test/e2e/artifacts/test-results',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list', { printSteps: true }]],
  use: { actionTimeout: 15_000, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node apps/extension/test/e2e/reset-data.mjs && pnpm --filter @indiansassist/api dev',
      cwd: repoRoot,
      url: `${apiUrl}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        PORT: apiPort,
        API_ORIGIN: apiUrl,
        METRICS_PORT: '0',
        PGLITE_DIR: './data/e2e-ext/pglite',
        STORAGE_FS_DIR: './data/e2e-ext/storage',
        RATE_LIMIT_DISABLED: '1',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'pnpm --filter @indiansassist/web dev',
      cwd: repoRoot,
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { VITE_API_URL: apiUrl },
    },
    {
      command: 'node apps/extension/test/e2e/fixture-server.mjs',
      cwd: repoRoot,
      url: `http://localhost:${fixturePort}/form.html`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { E2E_FIXTURE_PORT: fixturePort },
    },
  ],
});
