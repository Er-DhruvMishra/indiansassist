#!/usr/bin/env node
// Runs the Phase F specs, each against its own api with the settings it needs, so one command covers all three:
// f-camera with the defaults, f-mail with the api on the fake SMTP server, f-erasure with a short dev cooling-off.
// Each run resets its own data dir under ./data. E2E_API_PORT / E2E_WEB_PORT move the api and web servers as for
// every suite (ports 4000, 4100 and 4105 belong to other processes on the dev machine).
//
//   E2E_API_PORT=4140 E2E_WEB_PORT=5340 pnpm e2e:f
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smtpPort = process.env.E2E_SMTP_PORT || '2526';

const runs = [
  { spec: 'f-camera', env: { E2E_DATA_DIR: './data/e2e-f-camera' } },
  {
    spec: 'f-mail',
    env: {
      E2E_DATA_DIR: './data/e2e-f-mail',
      E2E_SMTP_PORT: smtpPort,
      MAIL_DRIVER: 'smtp',
      SMTP_URL: `smtp://127.0.0.1:${smtpPort}`,
      SMTP_REQUIRE_TLS: '0',
    },
  },
  { spec: 'f-erasure', env: { E2E_DATA_DIR: './data/e2e-f-erasure', ERASURE_DEV_COOLING_OFF_SEC: '5' } },
];

const failed = [];
for (const { spec, env } of runs) {
  console.log(`\n=== e2e:f ${spec}`);
  const r = spawnSync('pnpm', ['exec', 'playwright', 'test', spec, ...process.argv.slice(2)], {
    cwd: webRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) failed.push(spec);
}
console.log(failed.length ? `\ne2e:f failed: ${failed.join(', ')}` : '\ne2e:f: all three specs passed');
process.exit(failed.length ? 1 : 0);
