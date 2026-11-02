// Phase F (docs/specs/phase-f-contracts.md sections 3.1a, 3.1b, 4.4, 6.2e, 7.6e, 11): the compose / config.ts
// parity rule, the fleet key and agent-build mounts, and the phone-camera, service-worker and manifest locations.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkApiEnvParity,
  checkMainCompose,
  composeApiEnvKeys,
  configEnvKeys,
  DEV_ONLY_ENV,
  parseEnvFile,
} from '../infra/compose.mjs';
import {
  CAMERA_PERMISSIONS_POLICY,
  checkPhaseFLocations,
  checkReplayerLocation,
  checkSecurityHeaders,
} from '../infra/configs.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const compose = read('infra/docker-compose.yml');
const config = read('apps/api/src/config.ts');
const webConf = read('infra/nginx/web.conf');
const env = parseEnvFile(read('infra/.env.example'));

describe('config.ts envSchema keys', () => {
  it('reads every top-level key and nothing nested, commented or quoted', () => {
    const text = `
      const other = z.object({ NOT_ME: str('') });
      const envSchema = z.object({
        // COMMENTED: str(''),
        /** BLOCK_COMMENT: x */
        A_KEY: str('x: y'),
        B_KEY: z.enum(['a', 'b']).optional().default('a'),
        C_KEY: z.object({ NESTED: z.string() }).optional(),
        D_KEY: int(3),
      });
      const after = { AFTER: 1 };`;
    expect(configEnvKeys(text)).toEqual(['A_KEY', 'B_KEY', 'C_KEY', 'D_KEY']);
  });

  it('throws when the schema is missing', () => {
    expect(() => configEnvKeys('const x = 1;')).toThrow(/envSchema/);
  });

  it('finds the shipped keys, including the Phase D keys compose used to miss', () => {
    const keys = configEnvKeys(config);
    expect(keys.length).toBeGreaterThan(70);
    expect(keys).toEqual(
      expect.arrayContaining(['NODE_ENV', 'FLEET_DATA_KEY', 'MAIL_DRIVER', 'SMTP_URL', 'VAULT_SECRET_ID']),
    );
  });
});

describe('compose api parity (3.1b)', () => {
  it('the shipped compose passes every envSchema key that is not development only', () => {
    expect(checkApiEnvParity(configEnvKeys(config), composeApiEnvKeys(compose))).toEqual([]);
  });

  it('a config key compose does not pass is reported, a dev-only key is not', () => {
    const problems = checkApiEnvParity(['PORT', 'NEW_KEY', 'NODE_ID'], ['PORT']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/NEW_KEY/);
  });

  it('a dev-only key passed by compose is reported', () => {
    const problems = checkApiEnvParity(['PORT', 'EGRESS_ALLOW_HTTP'], ['PORT', 'EGRESS_ALLOW_HTTP']);
    expect(problems.join()).toMatch(/EGRESS_ALLOW_HTTP is development only/);
  });

  it('the allow-list is exactly the contract list', () => {
    expect([...DEV_ONLY_ENV].sort()).toEqual(
      [
        'NODE_ID',
        'PGLITE_DIR',
        'AGENT_DEV_STUB',
        'EGRESS_ALLOW_HTTP',
        'EGRESS_ALLOW_LOOPBACK',
        'SSO_DEV_DNS_SERVERS',
        'ERASURE_DEV_COOLING_OFF_SEC',
      ].sort(),
    );
  });
});

describe('compose fleet key and agent builds (3.1a)', () => {
  it('a FLEET_DATA_KEY with a default, a missing mount and a moved dist dir are reported', () => {
    expect(checkMainCompose(compose, env)).toEqual([]);
    const soft = compose.replace(
      'FLEET_DATA_KEY: ${FLEET_DATA_KEY:?set FLEET_DATA_KEY in infra/.env}',
      'FLEET_DATA_KEY: ${FLEET_DATA_KEY:-}',
    );
    expect(checkMainCompose(soft, env).join()).toMatch(/FLEET_DATA_KEY must be required/);
    const noMount = compose.replace('      - ./data/agent-msi:/data/agent-msi:ro\n', '');
    expect(checkMainCompose(noMount, env).join()).toMatch(/agent-msi:\/data\/agent-msi:ro/);
    const moved = compose.replace('AGENT_DIST_DIR: /data/agent-dist', 'AGENT_DIST_DIR: /srv/dist');
    expect(checkMainCompose(moved, env).join()).toMatch(/AGENT_DIST_DIR must be \/data\/agent-dist/);
  });

  it('non-secret Phase F keys keep the config.ts defaults when .env omits them', () => {
    for (const [k, def] of [
      ['AGENT_MIN_VERSION', '0.3.0'],
      ['MAIL_DRIVER', 'log'],
      ['SMTP_REQUIRE_TLS', 'true'],
      ['DEVICE_HELLO_RATE', '500'],
      ['WAKE_CONFIRM_SEC', '120'],
    ]) {
      expect(compose).toContain(`${k}: \${${k}:-${def}}`);
    }
  });
});

describe('nginx Phase F locations', () => {
  it('the shipped web.conf passes, and the SPA and replayer sets keep camera=()', () => {
    expect(checkPhaseFLocations(webConf)).toEqual([]);
    expect(checkSecurityHeaders(read('infra/nginx/security-headers.conf'))).toEqual([]);
    expect(checkReplayerLocation(webConf)).toEqual([]);
  });

  it('a missing /c location, a logged /c/ path or a widened replayer are reported', () => {
    const noC = webConf.replace('location = /c {', 'location = /cx {');
    expect(checkPhaseFLocations(noC).join()).toMatch(/missing location = \/c/);
    const logged = webConf.replace('    access_log off;\n    add_header Strict', '    add_header Strict');
    expect(checkPhaseFLocations(logged).join()).toMatch(/access_log off/);
    const widened = webConf.replace(
      /(location = \/replayer\.html \{[\s\S]*?Permissions-Policy ")camera=\(\)/,
      '$1camera=(self)',
    );
    expect(checkPhaseFLocations(widened).join()).toMatch(/exactly twice/);
    expect(checkReplayerLocation(widened).join()).toMatch(/Permissions-Policy/);
  });

  it('the camera locations must send exactly the camera policy and the rest of the SPA set', () => {
    expect(CAMERA_PERMISSIONS_POLICY).toBe('camera=(self), geolocation=(), display-capture=(), microphone=()');
    const noFrame = webConf.replace(
      /(location \^~ \/c\/ \{[\s\S]*?)    add_header X-Frame-Options "DENY" always;\n/,
      '$1',
    );
    expect(checkPhaseFLocations(noFrame).join()).toMatch(/\^~ \/c\/ lacks add_header X-Frame-Options/);
  });

  it('a cached service worker, a manifest without its MIME type and reset routes outside the auth limit are reported', () => {
    const cached = webConf.replace(
      /(location = \/sw\.js \{[\s\S]*?)add_header Cache-Control "no-cache" always;/,
      '$1add_header Cache-Control "max-age=3600" always;',
    );
    expect(checkPhaseFLocations(cached).join()).toMatch(/\/sw\.js must send Cache-Control/);
    const noMime = webConf.replace('default_type application/manifest+json;', 'default_type text/plain;');
    expect(checkPhaseFLocations(noMime).join()).toMatch(/application\/manifest\+json/);
    const noReset = webConf.replace('|password-reset/(request|confirm))$', ')$');
    expect(checkPhaseFLocations(noReset).join()).toMatch(/password-reset\/request/);
  });
});
