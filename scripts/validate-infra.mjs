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
import {
  checkApiEnvParity,
  checkMainCompose,
  checkTurnHostCompose,
  composeApiEnvKeys,
  configEnvKeys,
  parseEnvFile,
} from './infra/compose.mjs';
import {
  checkNginx,
  checkPhaseFLocations,
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
    // Phase E (docs/specs/phase-e-contracts.md section 10): every key documented, no default secret, no loosening
    // switch, and the retired OIDC_* keys gone (W86).
    for (const k of [
      'ORG_SECRETS_KEY',
      'ORG_SECRETS_KEYS_PREVIOUS',
      'ORG_SECRETS_FP_KEY',
      'EGRESS_PRIVATE_ALLOW',
      'EGRESS_METADATA_ADDRESSES',
      'AI_LOCAL_ENDPOINTS',
      'AI_LOCAL_MODEL',
      'AI_LOCAL_API_KEY',
      'AI_LOCAL_TIMEOUT_MS',
      'AI_ANTHROPIC_API_KEY',
      'AI_ANTHROPIC_REGIONS',
      'AI_ANTHROPIC_MODEL',
      'AI_ANTHROPIC_TIMEOUT_MS',
      'AI_ANTHROPIC_MAX_RETRIES',
    ]) {
      if (!env.has(k)) problems.push(`${k} is not documented (Phase E)`);
    }
    for (const k of ['ORG_SECRETS_KEY', 'ORG_SECRETS_KEYS_PREVIOUS', 'ORG_SECRETS_FP_KEY', 'AI_LOCAL_API_KEY', 'AI_ANTHROPIC_API_KEY']) {
      if (env.get(k)) problems.push(`${k} must be empty in the example (no default secrets)`);
    }
    for (const k of ['EGRESS_ALLOW_HTTP', 'EGRESS_ALLOW_LOOPBACK', 'SSO_DEV_DNS_SERVERS']) {
      if (env.get(k)) problems.push(`${k} must not be set in the production example (tests and local fakes only)`);
    }
    for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) {
      if (env.has(k)) problems.push(`${k} is retired (Phase E W86); remove it`);
    }
    if ((env.get('AUTH_PROVIDER') ?? 'local') !== 'local') problems.push('AUTH_PROVIDER must be local (Phase E W86)');
    if (env.get('AI_ANTHROPIC_MAX_RETRIES') !== '0') problems.push('AI_ANTHROPIC_MAX_RETRIES must default to 0');
    // Phase F (docs/specs/phase-f-contracts.md sections 3.1a, 11): the D keys Compose was missing and the F keys.
    for (const k of [
      'AGENT_MSI_DIST_DIR',
      'FLEET_DATA_KEY',
      'FLEET_DATA_KEYS_PREVIOUS',
      'DEVICE_HELLO_RATE',
      'WAKE_CONFIRM_SEC',
      'VAULT_ADDR',
      'VAULT_ROLE_ID',
      'VAULT_SECRET_ID',
      'MAIL_DRIVER',
      'SMTP_URL',
      'MAIL_FROM',
      'SMTP_REQUIRE_TLS',
      'BACKUP_RETENTION_DAYS',
    ]) {
      if (!env.has(k)) problems.push(`${k} is not documented (Phase F 3.1a)`);
    }
    for (const k of ['FLEET_DATA_KEY', 'FLEET_DATA_KEYS_PREVIOUS', 'VAULT_SECRET_ID', 'SMTP_URL']) {
      if (env.get(k)) problems.push(`${k} must be empty in the example (no default secrets)`);
    }
    if (env.get('ERASURE_DEV_COOLING_OFF_SEC')) {
      problems.push('ERASURE_DEV_COOLING_OFF_SEC must not be set in the production example (development only)');
    }
    if (env.get('SMTP_REQUIRE_TLS') !== 'true') problems.push('SMTP_REQUIRE_TLS must default to true (Phase F 4.1b)');
    return problems;
  });
  run('region origins / extension manifest', () => checkRegionAgreement(env, buildManifest));
  run('infra/docker-compose.yml', () => checkMainCompose(read('infra/docker-compose.yml'), env));
  run('api env parity (config.ts envSchema vs compose api)', () =>
    checkApiEnvParity(configEnvKeys(read('apps/api/src/config.ts')), composeApiEnvKeys(read('infra/docker-compose.yml'))),
  );
  run('infra/docker-compose.turn-host.yml', () => checkTurnHostCompose(read('infra/docker-compose.turn-host.yml')));
  run('infra/coturn/turnserver.conf', () => checkTurnserverConf(read('infra/coturn/turnserver.conf')));
  run('infra/nginx/*.conf', () => [
    ...checkNginx(read('infra/nginx/nginx.conf'), read('infra/nginx/web.conf'), read('infra/nginx/proxy-common.conf')),
    ...checkSecurityHeaders(read('infra/nginx/security-headers.conf')),
    ...checkReplayerLocation(read('infra/nginx/web.conf')),
    ...checkPhaseFLocations(read('infra/nginx/web.conf')),
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
