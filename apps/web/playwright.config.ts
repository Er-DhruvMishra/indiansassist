/**
 * Playwright config for the apps/web end-to-end tests. Three suites share this file:
 *
 *  - Package 1 (default): the two-browser session (`package1.spec.ts`). The API runs on a fresh PGlite database
 *    under ./data/e2e; one Chromium with fake media devices and an auto-selected screen drives both the Assist
 *    and the Desk. Run with `pnpm e2e`.
 *  - Package 3 (`E2E_P3=1`, via `pnpm e2e:p3`): the native-agent session (`package3.spec.ts`). The API runs on a
 *    separate PGlite database under ./data/e2e-p3 with SIGNUP_PLAN_TIER=p3_portable (so the signed-up org can
 *    create p3 tokens) and AGENT_DEV_STUB pointing at the built dev agent binary (so the download grant serves a
 *    real file). The Assist is a browser; the Desk is the Rust agent spawned as a child process by the spec.
 *  - Package 4 (`E2E_P4=1`, via `pnpm e2e:p4`): the fleet console's keyboard-only accessibility flows
 *    (`package4.spec.ts`, docs/specs/phase-d-contracts.md section 13.5). The API runs on a separate PGlite database
 *    under ./data/e2e-p4 with SIGNUP_PLAN_TIER=p4_installed, so the signed-up org can mint an enrollment token and
 *    the spec can enrol devices over REST. No agent, no media, no browser but the Assist's own.
 *
 * Ports 4000 and 5173 must be free; `E2E_API_PORT=4100` moves the API when :4000 is taken (the web app reads it
 * through VITE_API_URL). The three suites use different data dirs so they never share state.
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const headed = process.env.E2E_HEADED === '1';
const apiPort = process.env.E2E_API_PORT || '4000';
const apiUrl = `http://localhost:${apiPort}`;
// E2E_WEB_PORT and E2E_DATA_DIR let several suites run at once (the Phase E streams each use their own pair);
// the defaults keep every existing command unchanged.
const webPort = process.env.E2E_WEB_PORT || '5173';
const webUrl = `http://localhost:${webPort}`;
const dataDir = process.env.E2E_DATA_DIR || './data/e2e';
const originEnv = {
  WEB_ORIGIN: webUrl,
  REGION_ORIGINS: `in-mum=${webUrl},eu-fra=${webUrl},us-east=${webUrl}`,
};
const p3 = process.env.E2E_P3 === '1';
const p4 = process.env.E2E_P4 === '1';

const apiEnv: Record<string, string> = p4
  ? {
      PORT: apiPort,
      API_ORIGIN: apiUrl,
      METRICS_PORT: '0',
      PGLITE_DIR: './data/e2e-p4/pglite',
      STORAGE_FS_DIR: './data/e2e-p4/storage',
      RATE_LIMIT_DISABLED: '1',
      SIGNUP_PLAN_TIER: 'p4_installed',
      LOG_LEVEL: 'warn',
    }
  : p3
  ? {
      PORT: apiPort,
      API_ORIGIN: apiUrl,
      METRICS_PORT: '0',
      PGLITE_DIR: './data/e2e-p3/pglite',
      STORAGE_FS_DIR: './data/e2e-p3/storage',
      RATE_LIMIT_DISABLED: '1',
      SIGNUP_PLAN_TIER: 'p3_portable',
      // The download grant serves the built dev agent binary (run-p3.mjs sets AGENT_DEV_STUB).
      ...(process.env.AGENT_DEV_STUB ? { AGENT_DEV_STUB: process.env.AGENT_DEV_STUB } : {}),
      LOG_LEVEL: 'warn',
    }
  : {
      PORT: apiPort,
      API_ORIGIN: apiUrl,
      METRICS_PORT: '0',
      PGLITE_DIR: `${dataDir}/pglite`,
      STORAGE_FS_DIR: `${dataDir}/storage`,
      RATE_LIMIT_DISABLED: '1',
      LOG_LEVEL: 'warn',
      // The Phase E specs' local fakes (phase-e-contracts sections 2.2, 5.2a, 10): loopback HTTP egress for the
      // ticketing receiver and the IdPs, the fake DNS server for the domain TXT proof, the fake local model. All three
      // are refused by config.ts with NODE_ENV=production; the runner's environment still wins.
      EGRESS_ALLOW_HTTP: process.env.EGRESS_ALLOW_HTTP || '1',
      EGRESS_ALLOW_LOOPBACK: process.env.EGRESS_ALLOW_LOOPBACK || '1',
      SSO_DEV_DNS_SERVERS: process.env.SSO_DEV_DNS_SERVERS || `127.0.0.1:${process.env.SMOKE_SSO_DNS_PORT || '5391'}`,
      AI_LOCAL_ENDPOINTS: process.env.AI_LOCAL_ENDPOINTS || `in-mum=http://127.0.0.1:${process.env.E2E_AI_MODEL_PORT || '4194'}`,
    };
Object.assign(apiEnv, originEnv);
const resetCmd = p4
  ? 'node apps/web/e2e/reset-data-p4.mjs'
  : p3
    ? 'node apps/web/e2e/reset-data-p3.mjs'
    : 'node apps/web/e2e/reset-data.mjs';

export default defineConfig({
  testDir: './e2e',
  // The default suite also holds the Phase E specs (`enterprise-{sso,tickets,ai,residency}.spec.ts`, phase-e-contracts
  // section 11), so `pnpm e2e:e` and `playwright test enterprise-<stream>` find them.
  testMatch: p4 ? /package4\.spec\.ts$/ : p3 ? /package3\.spec\.ts$/ : /(package[12]|enterprise-[a-z]+)\.spec\.ts$/,
  outputDir: './e2e/artifacts/test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list', { printSteps: true }]],
  use: {
    baseURL: webUrl,
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
      command: `${resetCmd} && pnpm --filter @indiansassist/api dev`,
      cwd: repoRoot,
      url: `${apiUrl}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: apiEnv,
    },
    {
      command: `pnpm --filter @indiansassist/web dev --port ${webPort}`,
      cwd: repoRoot,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: { VITE_API_URL: apiUrl },
    },
  ],
});
