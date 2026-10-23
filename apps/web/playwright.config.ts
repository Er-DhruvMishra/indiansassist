/**
 * Playwright config for the Package 1 two-browser end-to-end test (apps/web/e2e). Starts the API on a fresh
 * PGlite database under ./data/e2e (rate limits off, metrics port off) and the Vite dev server, then drives
 * one Chromium with fake media devices and an auto-selected screen so getDisplayMedia / getUserMedia resolve
 * without pickers. Run from the repo root with `pnpm e2e` (ports 4000 and 5173 must be free; `E2E_API_PORT=4100 pnpm e2e`
 * moves the api when :4000 is taken, the web app reads it through VITE_API_URL).
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const headed = process.env.E2E_HEADED === '1';
const apiPort = process.env.E2E_API_PORT || '4000';
const apiUrl = `http://localhost:${apiPort}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './e2e/artifacts/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list', { printSteps: true }]],
  use: {
    baseURL: 'http://localhost:5173',
    // `chromium` channel = the full Chromium build in new headless mode (the headless shell has no screen capture).
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--auto-select-desktop-capture-source=Entire screen',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: [
    {
      command: 'node apps/web/e2e/reset-data.mjs && pnpm --filter @indiansassist/api dev',
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
        PGLITE_DIR: './data/e2e/pglite',
        STORAGE_FS_DIR: './data/e2e/storage',
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
  ],
});
