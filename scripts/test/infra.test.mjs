// Static validation of infra/ (no Docker): the shipped files must pass, and each class of contract drift must be
// caught by the checks in scripts/infra/*.mjs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateInfra } from '../validate-infra.mjs';
import {
  checkMainCompose,
  checkTurnHostCompose,
  interpolatedVars,
  parseCompose,
  parseEnvFile,
} from '../infra/compose.mjs';
import {
  checkNginx,
  checkRegionAgreement,
  checkReplayerLocation,
  checkSecurityHeaders,
  checkTurnserverConf,
  DENIED_PEER_RANGES,
} from '../infra/configs.mjs';
import { buildManifest } from '../../apps/extension/src/manifest.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const compose = read('infra/docker-compose.yml');
const env = parseEnvFile(read('infra/.env.example'));

describe('infra/scripts/init-env.sh', () => {
  it('gives a value to every variable Compose refuses to start without', () => {
    const code = compose.replace(/^\s*#.*$/gm, '');
    const required = [...new Set([...code.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]))];
    expect(required.length).toBeGreaterThan(0);
    const generated = new Set([...read('infra/scripts/init-env.sh').matchAll(/^\s*setv ([A-Z0-9_]+)/gm)].map((m) => m[1]));
    expect(required.filter((v) => !generated.has(v) && !env.get(v))).toEqual([]);
  });
});

describe('shipped infra passes every check', () => {
  it('validateInfra reports no problems', () => {
    const groups = validateInfra(ROOT);
    expect(groups.map((g) => g.name)).toHaveLength(7);
    for (const g of groups) expect(g.problems, g.name).toEqual([]);
  });

  it('both Compose files parse with the yaml package', () => {
    const main = parseCompose(compose).model;
    expect(Object.keys(main.services)).toEqual(
      expect.arrayContaining([
        'postgres',
        'valkey',
        'coturn',
        'seaweedfs',
        'api',
        'web',
        'keycloak',
        'garage',
        'migrate',
      ]),
    );
    expect(main.services.api.restart).toBe('unless-stopped'); // YAML merge keys resolved
    const host = parseCompose(read('infra/docker-compose.turn-host.yml')).model;
    expect(host.services.coturn.network_mode).toBe('host');
  });
});

describe('compose drift is detected', () => {
  it('a published postgres port', () => {
    const bad = compose.replace(
      '    networks: [backend]\n    # 5432',
      '    ports: ["5432:5432"]\n    networks: [backend]\n    # 5432',
    );
    expect(bad).not.toBe(compose);
    expect(checkMainCompose(bad, env).join('\n')).toMatch(/postgres: publishes ports/);
  });

  it('keycloak outside the sso profile', () => {
    const bad = compose.replace('profiles: [sso]', 'profiles: []');
    expect(checkMainCompose(bad, env).join('\n')).toMatch(/keycloak: must be in Compose profile 'sso'/);
  });

  it('a TURN secret that is not shared between api and coturn', () => {
    const bad = compose.replace('      TURN_SECRET: ${TURN_SECRET}\n', '      TURN_SECRET: ${API_TURN_SECRET}\n');
    expect(bad).not.toBe(compose);
    const problems = checkMainCompose(bad, env).join('\n');
    expect(problems).toMatch(/api: TURN_SECRET must come from/);
    expect(problems).toMatch(/API_TURN_SECRET.*not documented/);
  });

  it('a literal secret and a missing api variable', () => {
    const bad = compose
      .replace(
        '      VALKEYCLI_AUTH: ${VALKEY_PASSWORD}',
        '      VALKEYCLI_AUTH: ${VALKEY_PASSWORD}\n      EXTRA_PASSWORD: hunter2',
      )
      .replace(/^ {6}TURN_TTL_SECONDS:.*\n/m, '');
    const problems = checkMainCompose(bad, env).join('\n');
    expect(problems).toMatch(/valkey: EXTRA_PASSWORD has a literal value/);
    expect(problems).toMatch(/api: environment lacks TURN_TTL_SECONDS/);
  });

  it('garage as the default object store', () => {
    const bad = compose.replace('    profiles: [garage]\n', '');
    expect(checkMainCompose(bad, env).join('\n')).toMatch(/garage: must be opt-in/);
  });

  it('interpolation scan ignores comments and $$ escapes', () => {
    expect([...interpolatedVars('# ${COMMENTED}\na: ${A:-x} $${NOT} ${B:?y} # ${TRAILING}\n')]).toEqual(['A', 'B']);
  });

  it('turn-host override without host networking', () => {
    expect(
      checkTurnHostCompose('services:\n  coturn:\n    ports: !reset []\n    networks: !reset []\n').join('\n'),
    ).toMatch(/network_mode: host/);
  });
});

describe('nginx and coturn drift is detected', () => {
  const main = read('infra/nginx/nginx.conf');
  const web = read('infra/nginx/web.conf');
  const proxy = read('infra/nginx/proxy-common.conf');
  const headers = read('infra/nginx/security-headers.conf');
  const turn = read('infra/coturn/turnserver.conf');

  it('a /signal location without the websocket upgrade or with a short timeout', () => {
    const noUpgrade = web.replace('    proxy_set_header Upgrade $http_upgrade;\n', '');
    expect(checkNginx(main, noUpgrade, proxy).join('\n')).toMatch(/\/signal lacks the Upgrade header/);
    const short = web.replace('proxy_read_timeout 75s;', 'proxy_read_timeout 30s;');
    expect(checkNginx(main, short, proxy).join('\n')).toMatch(/proxy_read_timeout must be 75s/);
  });

  it('logging the query string', () => {
    const bad = main.replace('"$request_method $uri"', '"$request"');
    expect(checkNginx(bad, web, proxy).join('\n')).toMatch(/P4/);
  });

  it('a weakened CSP', () => {
    const bad = headers.replace("script-src 'self';", "script-src 'self' 'unsafe-eval';");
    expect(checkSecurityHeaders(bad).join('\n')).toMatch(/Content-Security-Policy is/);
  });

  it('Phase B: the SPA CSP without frame-src, and a /replayer.html location that is missing or framed like the SPA', () => {
    expect(checkSecurityHeaders(headers.replace(" frame-src 'self';", '')).join('\n')).toMatch(
      /Content-Security-Policy is/,
    );
    expect(checkReplayerLocation(web)).toEqual([]);
    expect(checkReplayerLocation(web.replace('location = /replayer.html', 'location = /replayer-old.html'))).toEqual([
      'web.conf: missing location = /replayer.html (Phase B 10.2)',
    ]);
    const framed = web.replace(
      'add_header Content-Security-Policy "frame-ancestors https://$host" always;',
      'add_header X-Frame-Options "DENY" always;',
    );
    const problems = checkReplayerLocation(framed).join('\n');
    expect(problems).toMatch(/lacks add_header Content-Security-Policy/);
    expect(problems).toMatch(/must not send X-Frame-Options/);
  });

  it('Phase B: REGION_ORIGINS, VITE_REGION_ORIGINS and the extension manifest must agree', () => {
    expect(checkRegionAgreement(env, buildManifest)).toEqual([]);
    const drift = new Map(env);
    drift.set('VITE_REGION_ORIGINS', 'in-mum=https://in.indiansassist.example');
    expect(checkRegionAgreement(drift, buildManifest).join('\n')).toMatch(/must list the same region=origin pairs/);
    const wildcard = () => ({ externally_connectable: { matches: ['https://*/*'] }, content_scripts: [] });
    expect(checkRegionAgreement(env, wildcard).join('\n')).toMatch(/externally_connectable/);
  });

  it('a missing denied-peer-ip range and a literal TURN secret', () => {
    expect(DENIED_PEER_RANGES).toHaveLength(14);
    const bad = turn
      .replace('denied-peer-ip=172.16.0.0-172.31.255.255\n', '')
      .replace('static-auth-secret=${TURN_SECRET}', 'static-auth-secret=hunter2');
    const problems = checkTurnserverConf(bad).join('\n');
    expect(problems).toMatch(/missing denied-peer-ip=172\.16\.0\.0-172\.31\.255\.255/);
    expect(problems).toMatch(/literal static-auth-secret/);
  });
});
