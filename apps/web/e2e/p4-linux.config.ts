/**
 * Playwright config for `pnpm e2e:p4:linux` (docs/specs/phase-f-contracts.md sections 1.5, 8.12 "End to end"): the
 * Assist is a Windows Chromium, the Desk is the dev Linux service (`ia-service --console`) and its desktop worker in
 * WSL, run by `agent/scripts/service-e2e.sh` against the fake logind on a private bus and the harness Xvfb :97
 * (`package4-linux.spec.ts`).
 *
 * WSL runs in NAT mode: the api listens on 0.0.0.0:4160 and the service reaches it through the forwarder
 * service-e2e.sh runs on 127.0.0.1:4160 inside WSL (`IA_E2E_API_FORWARD=<gateway>:4160`), because an enrollment
 * config allows plain http only to localhost. So `API_ORIGIN` (and the enroll.iaconfig the api mints) say
 * `http://127.0.0.1:4160`, which the browser reaches too. Ports: api 4160, web 5330, never 4000, 4100 or 4105; data
 * in ./data/e2e-linux-p4, reset at each run. The installers the Linux tab lists come from `<data>-installers`
 * (run-p4-linux.mjs resets it and copies `packaging/linux/out/dist/` into its `linux/` folder when a package build exists).
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const apiPort = process.env.E2E_API_PORT || '4160';
const webPort = process.env.E2E_WEB_PORT || '5330';
const dataDir = process.env.E2E_DATA_DIR || './data/e2e-linux-p4';
const TAKEN = ['4000', '4100', '4105'];
if (TAKEN.includes(apiPort) || TAKEN.includes(webPort)) {
  throw new Error('e2e:p4:linux never uses ports 4000, 4100 or 4105');
}
// The browser uses localhost, so the session cookie stays same-site with the web app.
const apiLocal = `http://localhost:${apiPort}`;
const installers = process.env.E2E_INSTALLERS_DIR || `${dataDir}-installers`;
const signingKey = process.env.E2E_TOKEN_SIGNING_KEY ?? '';
if (!/^[0-9a-f]{64}$/.test(signingKey)) throw new Error('run e2e:p4:linux through run-p4-linux.mjs (it sets E2E_TOKEN_SIGNING_KEY)');
const webUrl = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: /package4-linux\.spec\.ts$/,
  outputDir: './artifacts/test-results-linux-p4',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  expect: { timeout: 20_000 },
  reporter: [['list', { printSteps: true }]],
  use: {
    baseURL: webUrl,
    channel: 'chromium',
    headless: process.env.E2E_HEADED !== '1',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        // Host candidates in clear: the worker in WSL cannot resolve Chromium's mDNS names across the NAT.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: [
    {
      command: `node apps/web/e2e/reset-data-p3-linux.mjs && pnpm --filter @indiansassist/api dev`,
      cwd: repoRoot,
      url: `${apiLocal}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        HOST: '0.0.0.0',
        PORT: apiPort,
        API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        WEB_ORIGIN: webUrl,
        REGION_ORIGINS: `in-mum=${webUrl},eu-fra=${webUrl},us-east=${webUrl}`,
        METRICS_PORT: '0',
        PGLITE_DIR: `${dataDir}/pglite`,
        STORAGE_FS_DIR: `${dataDir}/storage`,
        AGENT_MSI_DIST_DIR: installers,
        // The fixed test-only region key whose public half the dev service is built with (run-p4-linux.mjs).
        TOKEN_SIGNING_KEY: signingKey,
        E2E_DATA_DIR: dataDir,
        RATE_LIMIT_DISABLED: '1',
        SIGNUP_PLAN_TIER: 'p4_installed',
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
      env: { VITE_API_URL: apiLocal },
    },
  ],
});
