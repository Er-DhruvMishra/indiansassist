/**
 * Playwright config for the Android-emulator specs (docs/specs/phase-f-contracts.md sections 1.5, 15.9): matches only
 * `*-emulator.spec.ts` (`camera-emulator.spec.ts`, `mobile-emulator.spec.ts`); no other config matches them. Run with
 * `IA_EMULATOR=1 pnpm e2e:emulator -- <spec>`. Without `IA_EMULATOR=1` no server is started and every spec skips
 * itself through `withEmulatorChrome` (emulator-chrome.ts), which also serialises runs with `data/.emulator.lock`.
 *
 * The api and web ports are the stream's emulator ports: E2E_API_PORT / E2E_WEB_PORT (camera 4310 / 5315, the
 * defaults; mobile 4320 / 5325). Ports 4000, 4100 and 4105 are refused. The data dir is E2E_DATA_DIR, one per
 * stream (camera ./data/e2e-camera-emulator, the default; mobile ./data/e2e-mobile-emulator), reset by reset-data.mjs
 * with its ./data containment check. The desktop Assist is this config's Chromium; the phone is Chrome on the
 * emulator, which reaches both ports as `localhost` through `adb reverse`. `adb reverse` connects to 127.0.0.1, so the
 * web server (a production build under `vite preview`) listens there (`--host 127.0.0.1`; Vite's `localhost` is `::1`
 * only on Windows) and the api on its default 0.0.0.0.
 */
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const apiPort = process.env.E2E_API_PORT || '4310';
const webPort = process.env.E2E_WEB_PORT || '5315';
const dataDir = process.env.E2E_DATA_DIR || './data/e2e-camera-emulator';
/** One build directory per web port, so the camera and mobile streams can build at once. */
const outDir = `e2e/artifacts/dist-emulator-${webPort}`;
const TAKEN = ['4000', '4100', '4105'];
if (TAKEN.includes(apiPort) || TAKEN.includes(webPort)) {
  throw new Error('e2e:emulator never uses ports 4000, 4100 or 4105');
}
const enabled = process.env.IA_EMULATOR === '1';
const apiUrl = `http://localhost:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: /-emulator\.spec\.ts$/,
  outputDir: './artifacts/test-results-emulator',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Booting the emulator and waiting for the lock happen inside the test.
  timeout: 45 * 60_000,
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
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: enabled
    ? [
        {
          command: `node apps/web/e2e/reset-data.mjs && pnpm --filter @indiansassist/api exec tsx src/server.ts`,
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
            LOG_LEVEL: 'warn',
          },
        },
        {
          // A production build served by `vite preview`, as in mobile.config.ts: the dev server's first-load dependency
          // optimisation reloads the phone's page (aborting a navigation that carries a single-use camera code), and its
          // hundreds of unbundled modules overload the software-rendered emulator.
          command: `pnpm --filter @indiansassist/web exec vite build --outDir ${outDir} --emptyOutDir && pnpm --filter @indiansassist/web exec vite build -c vite.replayer.config.ts --outDir ${outDir} && pnpm --filter @indiansassist/web exec vite preview --outDir ${outDir} --host 127.0.0.1 --port ${webPort} --strictPort`,
          cwd: repoRoot,
          url: `http://127.0.0.1:${webPort}`,
          reuseExistingServer: false,
          timeout: 300_000,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { VITE_API_URL: apiUrl },
        },
      ]
    : [],
});
