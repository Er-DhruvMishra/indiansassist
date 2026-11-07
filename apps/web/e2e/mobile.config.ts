/**
 * Playwright config for the mobile Assist console (docs/specs/phase-f-contracts.md sections 7, 15.6): `pnpm e2e:mobile`.
 *
 * Three projects with device descriptors, `pixel-7`, `iphone-15` and `ipad-pro-11`, **all on Chromium** (the only
 * browser installed; the iPhone and iPad layouts are tested by emulation, real Safari is a manual check, W120). The app
 * is built into `e2e/artifacts/dist-mobile` (so a concurrent `vite build` of `dist/` is never disturbed) and served
 * by `vite preview`, so the service worker and the manifest are the production ones.
 *
 * Ports (section 1.5): api E2E_API_PORT (default 4155), web E2E_WEB_PORT (default 5320), data E2E_DATA_DIR (default
 * ./data/e2e-mobile); ports 4000, 4100 and 4105 are refused; METRICS_PORT=0. The api runs with
 * SIGNUP_PLAN_TIER=p3_portable so one signed-up org can mint P1 and P3 tokens; with `E2E_P3=1` and `AGENT_BIN` /
 * `AGENT_DEV_STUB` set to the wave-0b copy of the dev agent the P3 case runs (never through `pnpm e2e:p3`, which
 * rebuilds the agent).
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const apiPort = process.env.E2E_API_PORT || '4155';
const webPort = process.env.E2E_WEB_PORT || '5320';
const dataDir = process.env.E2E_DATA_DIR || './data/e2e-mobile';
const TAKEN = ['4000', '4100', '4105'];
if (TAKEN.includes(apiPort) || TAKEN.includes(webPort)) throw new Error('e2e:mobile never uses ports 4000, 4100 or 4105');
const apiUrl = `http://localhost:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;
const outDir = 'e2e/artifacts/dist-mobile';

/** A device descriptor forced onto Chromium (the WebKit descriptors otherwise ask for WebKit). */
const onChromium = (d: (typeof devices)[string]) => ({ ...d, browserName: 'chromium' as const, channel: 'chromium' });

export default defineConfig({
  testDir: '.',
  testMatch: /(^|[\\/])mobile\.spec\.ts$/,
  outputDir: './artifacts/test-results-mobile',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list', { printSteps: true }]],
  use: {
    baseURL: webUrl,
    headless: process.env.E2E_HEADED !== '1',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    serviceWorkers: 'allow',
    launchOptions: {
      args: [
        '--auto-select-desktop-capture-source=Entire screen',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    { name: 'pixel-7', use: onChromium(devices['Pixel 7']) },
    { name: 'iphone-15', use: onChromium(devices['iPhone 15']) },
    { name: 'ipad-pro-11', use: onChromium(devices['iPad Pro 11']) },
  ],
  webServer: [
    {
      command: 'node apps/web/e2e/reset-data.mjs && pnpm --filter @indiansassist/api exec tsx src/server.ts',
      cwd: repoRoot,
      url: `${apiUrl}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
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
        ...(process.env.AGENT_DEV_STUB ? { AGENT_DEV_STUB: process.env.AGENT_DEV_STUB } : {}),
      },
    },
    {
      command: `pnpm --filter @indiansassist/web exec vite build --outDir ${outDir} --emptyOutDir && pnpm --filter @indiansassist/web exec vite build -c vite.replayer.config.ts --outDir ${outDir} && pnpm --filter @indiansassist/web exec vite preview --outDir ${outDir} --port ${webPort} --strictPort`,
      cwd: repoRoot,
      url: webUrl,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
      // VITE_E2E_OPS_HOOK keeps the console's `window.__iaOps` hook (mobile.spec.ts) in this build only.
      env: { VITE_API_URL: apiUrl, VITE_E2E_OPS_HOOK: '1' },
    },
  ],
});
