#!/usr/bin/env node
// `pnpm e2e:p3:mac` launcher (docs/specs/phase-f-contracts.md section 17.6), on the user's Mac:
//
//   1. builds the macOS dev agent into agent/target/e2e-mac (features media, macos, gui, dev; skip with
//      E2E_MAC_SKIP_BUILD=1, or point MAC_AGENT_BIN at a built binary);
//   2. builds the workspace packages when `packages/db/dist` or `packages/shared/dist` is missing (a fresh checkout);
//   3. runs Playwright with apps/web/e2e/p3-mac.config.ts: the api on 127.0.0.1:<E2E_API_PORT, default 4170>, the web
//      app on E2E_WEB_PORT (default 5340), data in E2E_DATA_DIR (default ./data/e2e-mac).
//
// Ports 4000, 4100 and 4105 are never used. Nothing is installed; TCC is never touched (A1-A3).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  console.error('e2e:p3:mac runs on macOS only');
  process.exit(1);
}
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');

if (process.env.E2E_MAC_SKIP_BUILD !== '1' && !process.env.MAC_AGENT_BIN) {
  const cargo = spawnSync('which', ['cargo']).status === 0 ? 'cargo' : `${process.env.HOME}/.cargo/bin/cargo`;
  const b = spawnSync(
    cargo,
    ['build', '--manifest-path', resolve(repoRoot, 'agent/Cargo.toml'), '--locked', '--release', '-p', 'ia-agent', '--bin',
      'IndiansAssist', '--no-default-features', '--features', 'media,macos,gui,dev'],
    { stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: resolve(repoRoot, 'agent/target/e2e-mac') } },
  );
  if (b.status !== 0) {
    console.error('e2e:p3:mac: the macOS dev agent did not build');
    process.exit(b.status ?? 1);
  }
}

// The api dev server imports the built workspace packages: build them on a fresh checkout.
if (['packages/db/dist', 'packages/shared/dist'].some((d) => !existsSync(resolve(repoRoot, d)))) {
  const p = spawnSync('pnpm', ['-r', '--filter', './packages/**', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (p.status !== 0) {
    console.error('e2e:p3:mac: the workspace packages did not build');
    process.exit(p.status ?? 1);
  }
}

const r = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'e2e/p3-mac.config.ts'], {
  cwd: webRoot,
  env: process.env,
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
