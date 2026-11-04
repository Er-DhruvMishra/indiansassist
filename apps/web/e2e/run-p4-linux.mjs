#!/usr/bin/env node
// `pnpm e2e:p4:linux` launcher (docs/specs/phase-f-contracts.md section 8.12 "End to end"):
//
//   1. reads the WSL default gateway (`ip route show default` inside WSL; NAT mode, it changes at each boot);
//   2. builds the dev Linux service, the logind fake and the dev worker inside WSL
//      (agent/scripts/service-e2e.sh build; skip with E2E_LINUX_SKIP_BUILD=1);
//   3. resets the installers folder the api serves (./data/e2e-linux-p4-installers) and, when `pnpm linux:pkg` has
//      built the packages, copies packaging/linux/out/dist/ into its linux/ sub-folder (section 8.11), so the
//      console's Linux tab lists the real deb and rpm;
//   4. runs Playwright with apps/web/e2e/p4-linux.config.ts (api 0.0.0.0:4160, web 5330, data ./data/e2e-linux-p4),
//      passing IA_E2E_API_FORWARD=<gateway>:4160 for service-e2e.sh's forwarder.
//
// Ports 4000, 4100 and 4105 are never used. Nothing is installed; the harness tears down only what it started.
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');
const distro = process.env.E2E_WSL_DISTRO || 'Ubuntu';
const apiPort = process.env.E2E_API_PORT || '4160';
if (['4000', '4100', '4105'].includes(apiPort)) {
  console.error('e2e:p4:linux never uses ports 4000, 4100 or 4105');
  process.exit(2);
}

const route = spawnSync('wsl.exe', ['-d', distro, '--', 'ip', 'route', 'show', 'default'], { encoding: 'utf8' });
const gw = /default via (\d+\.\d+\.\d+\.\d+)/.exec(route.stdout ?? '')?.[1];
if (!gw) {
  console.error(`e2e:p4:linux: could not read the WSL default gateway: ${route.stdout ?? ''}${route.stderr ?? ''}`);
  process.exit(1);
}
console.log(`e2e:p4:linux: WSL gateway ${gw}`);

// The service verifies an enroll.iaconfig only against the region keys compiled into it (`IA_TOKEN_PUBKEYS`, C
// section 2.4; it never enrolls from a config it cannot verify). The test api therefore signs with a fixed,
// test-only key (TOKEN_SIGNING_KEY, the e2e data is reset each run) whose public half is compiled into the dev
// build, so the build is reused across runs. It is a test fixture and protects nothing.
const signingSeed = createHash('sha256').update('indiansassist e2e:p4:linux test-only region signing key').digest();
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), signingSeed]);
const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
const regionPub = Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');

const toWsl = (p) => p.replace(/^([A-Za-z]):[\\/]/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
if (process.env.E2E_LINUX_SKIP_BUILD !== '1') {
  const script = toWsl(resolve(repoRoot, 'agent/scripts/service-e2e.sh'));
  const b = spawnSync('wsl.exe', ['-d', distro, '--', 'bash', script, 'build'], {
    stdio: 'inherit',
    // WSLENV carries just this one variable into WSL.
    env: { ...process.env, IA_TOKEN_PUBKEYS: regionPub, WSLENV: ['IA_TOKEN_PUBKEYS/u', process.env.WSLENV].filter(Boolean).join(':') },
  });
  if (b.status !== 0) {
    console.error('e2e:p4:linux: the dev Linux service did not build');
    process.exit(b.status ?? 1);
  }
}

const dataDir = resolve(repoRoot, process.env.E2E_DATA_DIR || './data/e2e-linux-p4');
const installers = resolve(repoRoot, process.env.E2E_INSTALLERS_DIR || `${dataDir}-installers`);
const rel = relative(resolve(repoRoot, 'data'), installers);
if (!rel || rel.startsWith('..')) {
  console.error(`e2e:p4:linux: refusing to reset ${installers} (not under ./data)`);
  process.exit(2);
}
rmSync(installers, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(installers, { recursive: true });
const dist = resolve(repoRoot, 'packaging/linux/out/dist');
if (existsSync(join(dist, 'manifest.json'))) {
  mkdirSync(join(installers, 'linux'), { recursive: true });
  for (const f of readdirSync(dist)) copyFileSync(join(dist, f), join(installers, 'linux', f));
  console.log(`e2e:p4:linux: serving the Linux packages from ${dist}`);
} else {
  console.log('e2e:p4:linux: no Linux package build (pnpm linux:pkg); the Linux tab shows the release-share text');
}

const env = {
  ...process.env,
  E2E_LINUX_GW: gw,
  E2E_API_PORT: apiPort,
  E2E_INSTALLERS_DIR: installers,
  E2E_TOKEN_SIGNING_KEY: signingSeed.toString('hex'),
  E2E_REGION_PUB: regionPub,
  IA_E2E_API_FORWARD: `${gw}:${apiPort}`,
};
const r = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', 'e2e/p4-linux.config.ts', ...process.argv.slice(2)], {
  cwd: webRoot,
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
