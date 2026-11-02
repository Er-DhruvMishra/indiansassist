#!/usr/bin/env node
// `pnpm e2e:p3:linux` launcher (docs/specs/phase-e-contracts.md section 7.10 "End to end"):
//
//   1. reads the WSL default gateway (`ip route show default` inside WSL; NAT mode, it changes at each boot);
//   2. builds the Linux dev agent inside WSL (agent/scripts/e2e-agent.sh build; skip with E2E_LINUX_SKIP_BUILD=1);
//   3. runs Playwright with apps/web/e2e/p3-linux.config.ts: the api on 0.0.0.0:<E2E_API_PORT|E2E_LINUX_PORT,
//      default 4115> with API_ORIGIN=http://<gateway>:<port>, the web app on E2E_WEB_PORT (default 5285), data in
//      E2E_DATA_DIR (default ./data/e2e-linux).
//
// Ports 4000 and 4100 are never used.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distro = process.env.E2E_WSL_DISTRO || 'Ubuntu';

const route = spawnSync('wsl.exe', ['-d', distro, '--', 'ip', 'route', 'show', 'default'], { encoding: 'utf8' });
const gw = /default via (\d+\.\d+\.\d+\.\d+)/.exec(route.stdout ?? '')?.[1];
if (!gw) {
  console.error(`e2e:p3:linux: could not read the WSL default gateway: ${route.stdout ?? ''}${route.stderr ?? ''}`);
  process.exit(1);
}
console.log(`e2e:p3:linux: WSL gateway ${gw}`);

if (process.env.E2E_LINUX_SKIP_BUILD !== '1') {
  const script = resolve(webRoot, '../../agent/scripts/e2e-agent.sh').replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
  const b = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', script, 'build'], { stdio: 'inherit' });
  if (b.status !== 0) {
    console.error('e2e:p3:linux: the Linux dev agent did not build');
    process.exit(b.status ?? 1);
  }
}

const env = { ...process.env, E2E_LINUX_GW: gw };
const r = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'e2e/p3-linux.config.ts'], {
  cwd: webRoot,
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
