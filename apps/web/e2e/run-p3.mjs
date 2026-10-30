#!/usr/bin/env node
// Cross-platform launcher for the Package 3 (native agent) e2e: sets the P3 switches and points the API's
// download stub at the freshly built dev agent binary, then runs Playwright with the shared config. Keeping the
// env here (instead of an inline VAR=... prefix) means the same command works on Windows cmd, PowerShell and bash.
//
//   pnpm e2e:p3            # builds the dev agent, then runs apps/web/e2e/package3.spec.ts
//   E2E_API_PORT=4100 pnpm e2e:p3   # move the API off :4000 when it is busy
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');

const binary =
  process.env.AGENT_BIN ||
  [
    resolve(repoRoot, 'agent/target/release/IndiansAssist.exe'),
    resolve(repoRoot, 'agent/target/debug/IndiansAssist.exe'),
  ].find((p) => existsSync(p));
if (!binary) {
  console.error('Package 3 e2e: no agent binary; run `pnpm agent:build:dev` first.');
  process.exit(1);
}

const env = {
  ...process.env,
  E2E_P3: '1',
  AGENT_DEV_STUB: binary,
  AGENT_BIN: binary,
};

const r = spawnSync('pnpm', ['exec', 'playwright', 'test'], { cwd: webRoot, env, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
