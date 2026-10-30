#!/usr/bin/env node
// Validates infra/ without Docker: both Compose files (parsed with `yaml`), infra/.env.example, the coturn
// template and the nginx configuration, against contracts sections 11.3-11.5, plus Phase B 10.2 / 12.2 / 13.5 (the
// /replayer.html header set, frame-src, the Phase B variables and the REGION_ORIGINS / VITE_REGION_ORIGINS /
// extension manifest agreement). Node >= 22.18 imports the extension's manifest.ts directly (type stripping).
//
//   node scripts/validate-infra.mjs            (or: pnpm validate:infra)
//
// Prints PASS / FAIL per file group and exits 1 when any problem is found.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkMainCompose, checkTurnHostCompose, parseEnvFile } from './infra/compose.mjs';
import {
  checkNginx,
  checkRegionAgreement,
  checkReplayerLocation,
  checkSecurityHeaders,
  checkTurnserverConf,
} from './infra/configs.mjs';
import { buildManifest } from '../apps/extension/src/manifest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs every check against the infra directory under `root`. Returns [{ name, problems }]. */
export function validateInfra(root = ROOT) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const groups = [];
  const run = (name, fn) => {
    try {
      groups.push({ name, problems: fn() });
    } catch (err) {
      groups.push({ name, problems: [`cannot check: ${err instanceof Error ? err.message : String(err)}`] });
    }
  };
  let env = null;
  run('infra/.env.example', () => {
    env = parseEnvFile(read('infra/.env.example'));
    const problems = [];
    const secrets = [
      'POSTGRES_OWNER_PASSWORD',
      'IA_APP_DB_PASSWORD',
      'SESSION_COOKIE_SECRET',
      'TOKEN_SIGNING_KEY',
      'TURN_SECRET',
      'VALKEY_PASSWORD',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'RECORDER_TOKEN',
    ];
    for (const k of secrets) {
      if (!env.has(k)) problems.push(`${k} is not documented`);
      else if (env.get(k) !== '') problems.push(`${k} must be empty in the example (no default secrets)`);
    }
    if (env.get('STORAGE_DRIVER') !== 's3' || !String(env.get('S3_ENDPOINT')).includes('seaweedfs:8333')) {
      problems.push('object storage must default to SeaweedFS (s3 driver, http://seaweedfs:8333)');
    }
    if (env.get('RATE_LIMIT_DISABLED') !== 'false') problems.push('RATE_LIMIT_DISABLED must be false');
    if (/stun\.l\.google\.com/.test(String(env.get('STUN_URLS'))))
      problems.push('third-party STUN must not be enabled by default');
    for (const k of ['REGION_ORIGINS', 'VITE_REGION_ORIGINS']) {
      for (const pair of String(env.get(k) ?? '')
        .split(',')
        .filter(Boolean)) {
        if (!/^(in-mum|eu-fra|us-east)=https:\/\//.test(pair))
          problems.push(`${k}: entry "${pair}" must be region=https://origin`);
      }
    }
    for (const k of [
      'EXTENSION_IDS',
      'EXTENSION_WEBSTORE_URL',
      'EXTENSION_EDGE_URL',
      'EXTENSION_MIN_VERSION',
      'MIRROR_RELAY_BUDGET_BYTES',
      'SIGNUP_PLAN_TIER',
    ]) {
      if (!env.has(k)) problems.push(`${k} is not documented (Phase B)`);
    }
    for (const k of ['AGENT_DIST_DIR', 'AGENT_MIN_VERSION', 'AGENT_ANDROID_APP_URL']) {
      if (!env.has(k)) problems.push(`${k} is not documented (Phase C)`);
    }
    if (env.get('AGENT_DEV_STUB')) problems.push('AGENT_DEV_STUB must be empty in the production example');
    return problems;
  });
  run('region origins / extension manifest', () => checkRegionAgreement(env, buildManifest));
  run('infra/docker-compose.yml', () => checkMainCompose(read('infra/docker-compose.yml'), env));
  run('infra/docker-compose.turn-host.yml', () => checkTurnHostCompose(read('infra/docker-compose.turn-host.yml')));
  run('infra/coturn/turnserver.conf', () => checkTurnserverConf(read('infra/coturn/turnserver.conf')));
  run('infra/nginx/*.conf', () => [
    ...checkNginx(read('infra/nginx/nginx.conf'), read('infra/nginx/web.conf'), read('infra/nginx/proxy-common.conf')),
    ...checkSecurityHeaders(read('infra/nginx/security-headers.conf')),
    ...checkReplayerLocation(read('infra/nginx/web.conf')),
  ]);
  return groups;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const groups = validateInfra();
  let failed = 0;
  for (const g of groups) {
    console.log(`${g.problems.length === 0 ? 'PASS' : 'FAIL'}  ${g.name}`);
    for (const p of g.problems) console.log(`      - ${p}`);
    if (g.problems.length > 0) failed++;
  }
  console.log(failed === 0 ? '\ninfra: all checks passed' : `\ninfra: ${failed} group(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}
