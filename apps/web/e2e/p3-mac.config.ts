/**
 * Playwright config for `pnpm e2e:p3:mac` (docs/specs/phase-f-contracts.md section 17.6): the Assist is a Chromium on the
 * Mac, the Desk is the macOS dev agent on the same Mac (`package3-mac.spec.ts`, `mac-agent-harness.ts`).
 *
 * Everything is on 127.0.0.1: the api on 4170, the web app on 5340, data in ./data/e2e-mac, never 4000, 4100 or 4105.
 * WebRTC stays on loopback (the agent runs with IA_ICE_LOOPBACK=1; Chromium may pair loopback candidates), so the
 * macOS application firewall, which does not filter loopback, never prompts.
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const apiPort = process.env.E2E_API_PORT || '4170';
const webPort = process.env.E2E_WEB_PORT || '5340';
const dataDir = process.env.E2E_DATA_DIR || './data/e2e-mac';
const TAKEN = ['4000', '4100', '4105'];
if (TAKEN.includes(apiPort) || TAKEN.includes(webPort)) {
  throw new Error('e2e:p3:mac never uses ports 4000, 4100 or 4105');
}
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: /package3-mac\.spec\.ts$/,
  outputDir: './artifacts/test-results-mac',
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
        // Host candidates in clear (no mDNS names), and loopback allowed, to pair with the agent's 127.0.0.1 ones.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--allow-loopback-in-peer-connection',
      ],
    },
  },
  webServer: [
    {
      command: `node apps/web/e2e/reset-data-p3-mac.mjs && pnpm --filter @indiansassist/api dev`,
      cwd: repoRoot,
      url: `${apiUrl}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        HOST: '127.0.0.1',
        PORT: apiPort,
        API_ORIGIN: apiUrl,
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
      // The browser talks to the api on localhost, like the page itself, so the session cookie is same-site.
      env: { VITE_API_URL: `http://localhost:${apiPort}` },
    },
  ],
});
