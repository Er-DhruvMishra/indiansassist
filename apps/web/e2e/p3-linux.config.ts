/**
 * Playwright config for `pnpm e2e:p3:linux` (docs/specs/phase-e-contracts.md sections 7.10, 15.7): the Assist is a
 * Windows Chromium, the Desk is the Linux dev agent in WSL (`package3-linux.spec.ts`, `linux-agent-harness.ts`).
 *
 * WSL runs in NAT mode, so the api listens on 0.0.0.0 and advertises `API_ORIGIN=http://<WSL gateway>:<port>`
 * (run-p3-linux.mjs reads the gateway and passes E2E_LINUX_GW): the agent in WSL reaches it there, and the browser
 * reaches the same api on localhost. Ports default to 4115 (api) and 5285 (web), never 4000 or 4100; the data dir
 * defaults to ./data/e2e-linux, so this suite never shares state with another one.
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const gateway = process.env.E2E_LINUX_GW || '127.0.0.1';
const apiPort = process.env.E2E_API_PORT || process.env.E2E_LINUX_PORT || '4115';
const webPort = process.env.E2E_WEB_PORT || '5285';
const dataDir = process.env.E2E_DATA_DIR || './data/e2e-linux';
const TAKEN = ['4000', '4100', '4105'];
if (TAKEN.includes(apiPort) || TAKEN.includes(webPort)) {
  throw new Error('e2e:p3:linux never uses ports 4000, 4100 or 4105');
}
const apiLocal = `http://localhost:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: /package3-linux\.spec\.ts$/,
  outputDir: './artifacts/test-results-linux',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list', { printSteps: true }]],
  use: {
    baseURL: webUrl,
    channel: 'chromium',
    headless: process.env.E2E_HEADED !== '1',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        // Host candidates in clear: the agent in WSL cannot resolve Chromium's mDNS names across the NAT.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: [
    {
      command: `node apps/web/e2e/reset-data-p3-linux.mjs && pnpm --filter @indiansassist/api exec tsx src/server.ts`,
      cwd: repoRoot,
      url: `${apiLocal}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        HOST: '0.0.0.0',
        PORT: apiPort,
        API_ORIGIN: `http://${gateway}:${apiPort}`,
        WEB_ORIGIN: webUrl,
        REGION_ORIGINS: `in-mum=${webUrl},eu-fra=${webUrl},us-east=${webUrl}`,
        METRICS_PORT: '0',
        PGLITE_DIR: `${dataDir}/pglite`,
        STORAGE_FS_DIR: `${dataDir}/storage`,
        E2E_DATA_DIR: dataDir,
        RATE_LIMIT_DISABLED: '1',
        SIGNUP_PLAN_TIER: 'p3_portable',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `pnpm --filter @indiansassist/web dev --port ${webPort} --strictPort`,
      cwd: repoRoot,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { IA_E2E_STATIC: '1', VITE_API_URL: apiLocal },
    },
  ],
});
