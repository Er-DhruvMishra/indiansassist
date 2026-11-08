// The all-in-one image without Docker: what the entrypoint renders, the static checks of scripts/infra/allinone.mjs,
// and the failure accounting of finish.sh (Linux only, it needs a real bash).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_ENV_DEFAULTED,
  API_ENV_FIXED,
  API_ENV_PASSTHROUGH,
  apiEnv,
  coturnEnv,
  detectIp,
  formatEnvFile,
  healthEnv,
  InputError,
  migrateEnv,
  parseInput,
  parseSecrets,
  PORTS,
  renderProxyCommon,
  renderProxyConf,
  renderWebConf,
  REQUIRED_SECRETS,
  runtimeConfigJs,
  seaweedEnv,
  valkeyConf,
} from '../../infra/allinone/render.mjs';
import { isLoopback, parseLocal, rootAllowed, sockets } from '../../infra/allinone/smoke-inside.mjs';
import {
  checkAllinoneDockerfile,
  checkAllinoneRuntime,
  checkDockerWorkflow,
  checkScriptText,
} from '../infra/allinone.mjs';
import { checkApiEnvParity, configEnvKeys } from '../infra/compose.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SECRETS = Object.fromEntries(REQUIRED_SECRETS.map((k) => [k, `value${k.length}`]));
const secretsFile = Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`).join('\n');
const webConf = read('infra/nginx/web.conf');
const proxyCommon = read('infra/nginx/proxy-common.conf');
const input = (extra = {}) => parseInput({ IA_DOMAIN: 'in.example.com', ...extra });
const proxied = (extra = {}) => input({ IA_PROXY_MODE: '1', ...extra });

describe('parseInput', () => {
  it('needs only IA_DOMAIN and defaults the rest', () => {
    expect(input()).toMatchObject({
      domain: 'in.example.com',
      origin: 'https://in.example.com',
      region: 'in-mum',
      proxy: false,
      httpPort: 8080,
      turnMinPort: 49160,
      turnMaxPort: 49200,
    });
  });

  it('lower-cases the domain', () => {
    expect(input({ IA_DOMAIN: 'IN.Example.COM' }).domain).toBe('in.example.com');
  });

  it('says what is wrong when IA_DOMAIN is missing', () => {
    expect(() => parseInput({})).toThrow(/IA_DOMAIN is required/);
  });

  it.each(['https://in.example.com', 'in.example.com:8443', 'in.example.com/x', 'a b.com', '-bad.com', 'x;y.com'])(
    'rejects the domain %s, which would reach nginx and coturn templates',
    (IA_DOMAIN) => {
      expect(() => parseInput({ IA_DOMAIN })).toThrow(/host name only/);
    },
  );

  it('reports every problem at once', () => {
    try {
      parseInput({ IA_DOMAIN: 'x.example', IA_REGION: 'mars', IA_HTTP_PORT: '99999', IA_PUBLIC_IP: 'nope' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect(err.problems).toHaveLength(3);
    }
  });

  it('accepts a public/private NAT pair and refuses a third part', () => {
    expect(input({ IA_PUBLIC_IP: '203.0.113.10/10.0.0.5' }).publicIp).toBe('203.0.113.10/10.0.0.5');
    expect(() => input({ IA_PUBLIC_IP: '1.1.1.1/2.2.2.2/3.3.3.3' })).toThrow(/IA_PUBLIC_IP/);
  });

  it('validates trusted proxies, which are written into nginx', () => {
    expect(proxied({ IA_TRUSTED_PROXIES: '10.0.0.0/8, ::1/128,192.0.2.1' }).trustedProxies).toEqual(['10.0.0.0/8', '::1/128', '192.0.2.1']);
    for (const bad of ['10.0.0.0/33', 'x', '10.0.0.0/8; evil', '1.1.1.1/24/8']) {
      expect(() => proxied({ IA_TRUSTED_PROXIES: bad })).toThrow(/IA_TRUSTED_PROXIES/);
    }
  });

  it.each(['1', 'true', 'YES', 'on'])('turns proxy mode on for %s', (IA_PROXY_MODE) => {
    expect(input({ IA_PROXY_MODE }).proxy).toBe(true);
  });

  it('refuses a TURN range that runs backwards', () => {
    expect(() => input({ TURN_MIN_PORT: '50000', TURN_MAX_PORT: '49000' })).toThrow(/TURN_MIN_PORT/);
  });
});

describe('parseSecrets', () => {
  it('reads every required key and nothing else', () => {
    const got = parseSecrets(`${secretsFile}\nWEB_ORIGIN=https://placeholder.example\n# COMMENT=x\n`);
    expect(Object.keys(got).sort()).toEqual([...REQUIRED_SECRETS].sort());
  });

  it('names a missing key and never its neighbours values', () => {
    const text = secretsFile.replace(/^TOKEN_SIGNING_KEY=.*$/m, 'TOKEN_SIGNING_KEY=');
    try {
      parseSecrets(text);
      expect.unreachable();
    } catch (err) {
      expect(err.problems).toEqual(['TOKEN_SIGNING_KEY is missing or empty in the secrets file']);
      expect(err.message).not.toContain('value');
    }
  });

  it('requires the keys the production api refuses to boot without', () => {
    expect(REQUIRED_SECRETS).toEqual(expect.arrayContaining(['FLEET_DATA_KEY', 'ORG_SECRETS_KEY', 'ORG_SECRETS_FP_KEY', 'TOKEN_SIGNING_KEY']));
  });
});

describe('the api environment', () => {
  const env = apiEnv(input(), SECRETS, {}, true);

  it('passes every envSchema key that is not development only (Phase F 3.1b parity)', () => {
    expect(checkApiEnvParity(configEnvKeys(read('apps/api/src/config.ts')), [...API_ENV_FIXED, ...API_ENV_DEFAULTED, ...API_ENV_PASSTHROUGH])).toEqual([]);
  });

  it('never holds the owner credential', () => {
    expect(env.MIGRATE_DATABASE_URL).toBe('');
    expect(Object.values(env).join('\n')).not.toContain(SECRETS.POSTGRES_OWNER_PASSWORD);
  });

  it('connects as ia_app on loopback', () => {
    expect(env.DATABASE_URL).toBe(`postgres://ia_app:${SECRETS.IA_APP_DB_PASSWORD}@127.0.0.1:${PORTS.postgres}/indiansassist`);
    expect(env.DB_APP_ROLE).toBe('ia_app');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.REDIS_URL).toBe(`redis://:${SECRETS.VALKEY_PASSWORD}@127.0.0.1:${PORTS.valkey}/0`);
  });

  it('meets the production refinements of config.ts', () => {
    expect(env.NODE_ENV).toBe('production');
    expect(env.API_ORIGIN).toBe(env.WEB_ORIGIN);
    expect(env.WEB_ORIGIN).toMatch(/^https:/);
    expect(env.SERVED_REGIONS).toBe(env.DEFAULT_REGION);
    expect(env.RATE_LIMIT_DISABLED).toBe('false');
    expect(env.TRUST_PROXY).toBe('true');
  });

  it('is https-origin in proxy mode too (nginx is the plain hop, not the public edge)', () => {
    expect(apiEnv(proxied(), SECRETS, {}, false).WEB_ORIGIN).toBe('https://in.example.com');
  });

  it('keeps release builds in the data volume by default, for an operator to fill', () => {
    expect(env.AGENT_DIST_DIR).toBe('/data/agent-dist');
    expect(env.AGENT_MSI_DIST_DIR).toBe('/data/agent-msi');
    expect(apiEnv(input(), SECRETS, { AGENT_DIST_DIR: '/data/custom' }, true).AGENT_DIST_DIR).toBe('/data/custom');
  });

  it('derives TURN and the region list from the domain at run time', () => {
    expect(env.TURN_URLS).toBe('turn:in.example.com:3478?transport=udp,turn:in.example.com:3478?transport=tcp,turns:in.example.com:5349');
    expect(env.STUN_URLS).toBe('stun:in.example.com:3478');
    expect(env.ICE_OWN_HOST_SUFFIXES).toBe('in.example.com');
    expect(env.REGION_ORIGINS).toBe('in-mum=https://in.example.com');
  });

  it('does not advertise turns: without a certificate', () => {
    expect(apiEnv(proxied(), SECRETS, {}, false).TURN_URLS).not.toContain('turns:');
  });

  it('passes an operator setting through, and leaves unset or empty ones to config.ts', () => {
    const got = apiEnv(input(), SECRETS, { SIGNUP_PLAN_TIER: 'p3_agent', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://h:587', LOG_LEVEL: '' }, true);
    expect(got).toMatchObject({ SIGNUP_PLAN_TIER: 'p3_agent', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://h:587' });
    expect(got).not.toHaveProperty('LOG_LEVEL');
  });

  it('ignores an attempt to override what the security properties depend on', () => {
    const got = apiEnv(input(), SECRETS, { DATABASE_URL: 'postgres://evil', RATE_LIMIT_DISABLED: 'true', MIGRATE_DATABASE_URL: 'x', HOST: '0.0.0.0' }, true);
    expect(got.DATABASE_URL).not.toContain('evil');
    expect(got.RATE_LIMIT_DISABLED).toBe('false');
    expect(got.MIGRATE_DATABASE_URL).toBe('');
    expect(got.HOST).toBe('127.0.0.1');
  });

  it('encodes a credential that is not URL-safe', () => {
    expect(apiEnv(input(), { ...SECRETS, IA_APP_DB_PASSWORD: 'a/b@c' }, {}, true).DATABASE_URL).toContain('ia_app:a%2Fb%40c@');
  });
});

describe('the other services', () => {
  it('only the migrate step gets the owner credential', () => {
    expect(migrateEnv(SECRETS).MIGRATE_DATABASE_URL).toBe(`postgres://ia_owner:${SECRETS.POSTGRES_OWNER_PASSWORD}@127.0.0.1:${PORTS.postgres}/indiansassist`);
    expect(JSON.stringify(seaweedEnv(input(), SECRETS))).not.toContain(SECRETS.POSTGRES_OWNER_PASSWORD);
    expect(JSON.stringify(coturnEnv(input(), SECRETS, '10.0.0.1'))).not.toContain(SECRETS.POSTGRES_OWNER_PASSWORD);
  });

  it('coturn takes its realm and external address at run time', () => {
    expect(coturnEnv(input({ IA_PUBLIC_IP: '203.0.113.10' }), SECRETS, '10.0.0.1')).toMatchObject({
      TURN_REALM: 'in.example.com',
      TURN_EXTERNAL_IP: '203.0.113.10',
      TURN_MIN_PORT: '49160',
    });
    expect(coturnEnv(input(), SECRETS, '10.0.0.1').TURN_EXTERNAL_IP).toBe('10.0.0.1');
  });

  it('SeaweedFS binds and registers on loopback only', () => {
    const e = seaweedEnv(input(), SECRETS);
    expect(e.SEAWEED_BIND_IP).toBe('127.0.0.1');
    expect(e.SEAWEED_EXTRA_ARGS).toContain('-ip=127.0.0.1');
    expect(e.S3_BUCKET).toBe('ia-recordings-in-mum');
  });

  it('Valkey binds to loopback, requires its password, and refuses one that could break the file', () => {
    const c = valkeyConf(SECRETS);
    expect(c).toContain('bind 127.0.0.1');
    expect(c).toContain(`requirepass ${SECRETS.VALKEY_PASSWORD}`);
    expect(() => valkeyConf({ ...SECRETS, VALKEY_PASSWORD: 'a b"\nport 1' })).toThrow(/valkey\.conf/);
  });

  it('the healthcheck probes the host nginx is actually bound to', () => {
    expect(healthEnv(input(), SECRETS).IA_HEALTH_HOST).toBe('127.0.0.1');
    expect(healthEnv(proxied({ IA_HTTP_BIND: '10.1.2.3' }), SECRETS).IA_HEALTH_HOST).toBe('10.1.2.3');
  });

  it('detectIp takes the first external IPv4 and falls back to loopback', () => {
    expect(detectIp({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth0: [{ family: 'IPv4', internal: false, address: '172.17.0.2' }] })).toBe('172.17.0.2');
    expect(detectIp({})).toBe('127.0.0.1');
  });

  it('quotes env files so a value cannot run as shell', () => {
    expect(formatEnvFile({ A: "it's $(rm -rf /)" })).toBe(`export A='it'\\''s $(rm -rf /)'\n`);
    expect(() => formatEnvFile({ A: 'x\ny' })).toThrow(/single line/);
  });
});

describe('runtime-config.js', () => {
  it('carries the origin and the region list as data', () => {
    const js = runtimeConfigJs(input(), {});
    expect(js).toBe('window.__IA_RUNTIME_CONFIG__ = {"apiUrl":"https://in.example.com","regionOrigins":"in-mum=https://in.example.com"};\n');
  });

  it('uses an operator region list for a multi-region deployment', () => {
    const list = 'in-mum=https://in.example.com,eu-fra=https://eu.example.com';
    expect(runtimeConfigJs(input(), { REGION_ORIGINS: list })).toContain(`"regionOrigins":"${list}"`);
  });
});

describe('nginx rendering (one web.conf, two modes)', () => {
  it('TLS mode only repoints the upstream', () => {
    const out = renderWebConf(webConf, input());
    expect(out).toContain(`server 127.0.0.1:${PORTS.api};`);
    expect(out).not.toContain('server api:4000;');
    expect(out).toContain('listen 443 ssl;');
    expect(out).toContain('return 301 https://$host$request_uri;');
    expect(out.split('\n')).toHaveLength(webConf.split('\n').length);
  });

  describe('proxy mode', () => {
    const out = renderWebConf(webConf, proxied({ IA_HTTP_PORT: '8090' }));

    it('is plain HTTP on the one port, with no redirect and no TLS directive', () => {
      expect(out).toMatch(/^\s*listen 8090;$/m);
      expect(out).toMatch(/^\s*listen \[::\]:8090;$/m);
      for (const gone of ['listen 443', 'ssl_certificate', 'http2 on', 'return 301', 'listen 80;', 'acme-challenge']) {
        expect(out).not.toContain(gone);
      }
    });

    it('has exactly one server block and balanced braces', () => {
      expect(out.match(/^server \{/gm)).toHaveLength(1);
      expect(out.split('{').length).toBe(out.split('}').length);
    });

    it('keeps every location, limit and header of the TLS configuration', () => {
      for (const kept of ['location /api/', 'location = /signal', 'location = /.well-known/indiansassist.json', 'location = /runtime-config.js', 'limit_conn ia_conn 200', 'zone=ia_auth', 'security-headers.conf', 'client_max_body_size 110m']) {
        expect(out).toContain(kept);
      }
    });

    it('names the public domain in the replayer frame-ancestors, whatever Host the proxy sends', () => {
      expect(out).toContain('frame-ancestors https://in.example.com');
      expect(out).not.toContain('https://$host');
    });

    it('can bind one address and then has no IPv6 listener', () => {
      const bound = renderWebConf(webConf, proxied({ IA_HTTP_BIND: '127.0.0.1' }));
      expect(bound).toMatch(/^\s*listen 127\.0\.0\.1:8080;$/m);
      expect(bound).not.toContain('[::]');
    });
  });

  it('drops the IPv6 listeners on a host without IPv6', () => {
    expect(renderWebConf(webConf, input(), { ipv6: false })).not.toContain('[::]');
  });

  it('fails loudly when web.conf drifts from what the renderer expects', () => {
    expect(() => renderWebConf('upstream x { server other:1; }', input())).toThrow(/drift/);
    expect(() => renderWebConf(webConf.replace('http2 on;', 'http3 on;'), proxied())).toThrow(/drift/);
  });

  it('never sends a client-chosen scheme to the api', () => {
    const conf = renderProxyConf(proxied());
    expect(renderProxyCommon(proxyCommon)).toContain('proxy_set_header X-Forwarded-Proto $ia_forwarded_proto;');
    expect(renderProxyCommon(proxyCommon)).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(conf).toContain('default $scheme;');
    expect(conf).toContain('"1:https" https;');
    expect(conf).toContain('geo $realip_remote_addr $ia_trusted_proxy');
  });

  it('realip trusts exactly the configured range', () => {
    const conf = renderProxyConf(proxied({ IA_TRUSTED_PROXIES: '10.9.0.0/16' }));
    expect(conf.match(/^set_real_ip_from .*$/gm)).toEqual(['set_real_ip_from 10.9.0.0/16;']);
    expect(conf).toContain('real_ip_header X-Forwarded-For;');
    expect(conf).toContain('real_ip_recursive on;');
  });
});

describe('the smoke inside the container', () => {
  it('decodes /proc/net addresses', () => {
    expect(parseLocal('0100007F:3C8C')).toEqual({ addr: '127.0.0.1', port: 15500 });
    expect(parseLocal('00000000:0050')).toEqual({ addr: '0.0.0.0', port: 80 });
    expect(parseLocal('00000000000000000000000001000000:1F90').addr).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
  });

  it('classifies loopback, including a v4-mapped address', () => {
    expect(isLoopback('127.0.0.11')).toBe(true);
    expect(isLoopback('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true);
    expect(isLoopback('0000:0000:0000:0000:0000:ffff:7f00:0001')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('172.17.0.2')).toBe(false);
    expect(isLoopback('0000:0000:0000:0000:0000:0000:0000:0000')).toBe(false);
  });

  it('reads listening TCP and bound UDP, skipping established connections', () => {
    const header = 'sl local rem st tx rx tr tm re uid to inode\n';
    const files = {
      '/proc/net/tcp': `${header}0: 0100007F:3C8C 00000000:0000 0A 0 0 0 0 0 111 1\n1: 0100007F:3C8C 0100007F:9999 01 0 0 0 0 0 222 1\n`,
      '/proc/net/udp': `${header}0: 00000000:0D96 00000000:0000 07 0 0 0 0 0 333 1\n`,
    };
    const read = (p) => {
      if (!(p in files)) throw new Error('absent');
      return files[p];
    };
    expect(sockets(read)).toEqual([
      { proto: 'tcp', addr: '127.0.0.1', port: 15500, inode: '111' },
      { proto: 'udp', addr: '0.0.0.0', port: 3478, inode: '333' },
    ]);
  });

  it('allows only the processes that must be root', () => {
    for (const ok of ['/bin/bash /ia/bin/entrypoint.sh', 'runsvdir -P /ia/sv', 'runsv api', 'nginx: master process nginx -g daemon off;']) {
      expect(rootAllowed(ok)).toBe(true);
    }
    for (const bad of ['node dist/server.js', 'nginx: worker process', 'postgres -D /data/postgres', 'valkey-server 127.0.0.1:16379']) {
      expect(rootAllowed(bad)).toBe(false);
    }
  });
});

describe('static checks: the shipped files pass', () => {
  it('Dockerfile', () => {
    expect(checkAllinoneDockerfile(read('infra/allinone/Dockerfile'), read('apps/api/Dockerfile'))).toEqual([]);
  });

  it('scripts', () => {
    expect(checkAllinoneRuntime({ entrypoint: read('infra/allinone/entrypoint.sh'), service: read('infra/allinone/service.sh'), render: read('infra/allinone/render.mjs') })).toEqual([]);
  });

  it('workflow', () => {
    expect(checkDockerWorkflow(read('.github/workflows/docker.yml'))).toEqual([]);
  });
});

describe('static checks: each drift is caught', () => {
  const dockerfile = read('infra/allinone/Dockerfile');
  const api = read('apps/api/Dockerfile');
  const runtime = { entrypoint: read('infra/allinone/entrypoint.sh'), service: read('infra/allinone/service.sh'), render: read('infra/allinone/render.mjs') };
  const workflow = read('.github/workflows/docker.yml');
  const dockerProblems = (t) => checkAllinoneDockerfile(t, api).join('\n');
  const runtimeProblems = (patch) => checkAllinoneRuntime({ ...runtime, ...patch }).join('\n');
  const workflowProblems = (t) => checkDockerWorkflow(t).join('\n');

  it.each([
    ['a different SeaweedFS', (t) => t.replace('chrislusf/seaweedfs:3.80', 'chrislusf/seaweedfs:3.90'), /SeaweedFS/],
    ['another Postgres major', (t) => t.replace('ARG PG_MAJOR=16', 'ARG PG_MAJOR=17'), /Postgres/],
    ['a domain compiled in', (t) => t.replace('FROM manifests AS build\n', 'FROM manifests AS build\nENV VITE_API_URL=https://x.example\n'), /domain/],
    ['a forked coturn template', (t) => t.replace('COPY infra/coturn/turnserver.conf', 'COPY infra/allinone/turnserver.conf'), /turnserver\.conf/],
    ['a USER line', (t) => t.replace('VOLUME /data', 'USER nobody\nVOLUME /data'), /USER/],
    ['no health check', (t) => t.replace(/^HEALTHCHECK.*$/m, ''), /HEALTHCHECK/],
    ['a uid adduser refuses', (t) => t.replace('postgres:801', 'postgres:2001'), /system range/],
    ['the supervisor package', (t) => t.replace('coturn runit openssl', 'coturn supervisor openssl'), /OSI/],
    ['an unchecked PGDG key', (t) => t.replace('B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8', 'ANY'), /fingerprint/],
    ['a floating base image', (t) => t.replace('ARG NODE_IMAGE=node:22-bookworm-slim', 'ARG NODE_IMAGE=node:latest'), /:latest|NODE_IMAGE/],
  ])('Dockerfile: %s', (_name, patch, want) => {
    expect(dockerProblems(patch(dockerfile))).toMatch(want);
  });

  it('Dockerfile: the build drifting from apps/api/Dockerfile', () => {
    const drifted = api.replace('ARG PNPM_VERSION=11.24.0', 'ARG PNPM_VERSION=99.0.0');
    expect(checkAllinoneDockerfile(dockerfile, drifted).join('\n')).toMatch(/PNPM_VERSION/);
    const moreCopies = api.replace('COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist', 'COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist\nCOPY --from=build --chown=node:node /app/apps/api/assets /app/apps/api/assets');
    expect(checkAllinoneDockerfile(dockerfile, moreCopies).join('\n')).toMatch(/assets/);
  });

  it.each([
    ['services inherit the container environment', { entrypoint: runtime.entrypoint.replace('env -i PATH="$PATH" runsvdir', 'runsvdir') }, /clean environment/],
    ['keys regenerated over a database', { entrypoint: runtime.entrypoint.replace('Refusing to generate new keys', 'Generating') }, /regenerate/],
    ['Postgres stopped first', { entrypoint: runtime.entrypoint.replace('sv -w 45 force-stop "$SV/postgres"', '').replace('sv -w 20 force-stop', 'sv -w 45 force-stop "$SV/postgres"\nsv -w 20 force-stop') }, /stop order/],
    ['FORCE=1', { entrypoint: `${runtime.entrypoint}\nFORCE=1\n` }, /FORCE/],
    ['tracing on', { service: `set -x\n${runtime.service}` }, /set -x/],
    ['the api as root', { service: runtime.service.replace('as_user ia-api node dist/server.js', 'exec node dist/server.js') }, /ia-api/],
    ['Postgres on every interface', { service: runtime.service.replace('listen_addresses=127.0.0.1', "listen_addresses='*'") }, /loopback/],
    ['the owner credential in the api shell', { service: runtime.service.replace('( load_env migrate; cd /app/apps/api; as_user ia-migrate node ia-migrate.mjs )', 'load_env migrate; ( cd /app/apps/api; as_user ia-migrate node ia-migrate.mjs )') }, /subshell/],
    ['the api given the owner URL', { render: runtime.render.replace("MIGRATE_DATABASE_URL: '',", 'MIGRATE_DATABASE_URL: secrets.X,') }, /empty MIGRATE/],
  ])('scripts: %s', (_name, patch, want) => {
    expect(runtimeProblems(patch)).toMatch(want);
  });

  it.each([
    ['an action on a tag', (t) => t.replace(/docker\/login-action@[0-9a-f]{40}/, 'docker/login-action@v4'), /not pinned/],
    ['a missing version comment', (t) => t.replace(' # v4.8.0', ''), /version comment/],
    ['packages: write at the top', (t) => t.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  packages: write\n'), /publish job only/],
    ['publish without the smoke', (t) => t.replace('needs: build-smoke', 'needs: []'), /need build-smoke/],
    ['no smoke step', (t) => t.replace('bash infra/allinone/smoke.sh "$LOCAL_TAG"', 'true'), /smoke\.sh/],
    ['an uppercase image name', (t) => t.replace('IMAGE: ghcr.io/er-dhruvmishra', 'IMAGE: ghcr.io/Er-DhruvMishra'), /image must be/],
    ['publishing on every push', (t) => t.replace(/^(\s+)if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| github\.event_name == 'workflow_dispatch'\n(\s+runs-on)/m, '$2'), /publish only/],
  ])('workflow: %s', (_name, patch, want) => {
    expect(workflowProblems(patch(workflow))).toMatch(want);
  });

  it('a CRLF script and a missing shebang are reported', () => {
    expect(checkScriptText('x', '#!/bin/sh\r\necho\r\n').join()).toMatch(/carriage return/);
    expect(checkScriptText('x', 'echo hi\n').join()).toMatch(/shebang/);
    expect(checkScriptText('x', '#!/bin/bash\necho\n')).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('finish.sh failure accounting', () => {
  let dir;
  const finish = (service, env = {}) =>
    spawnSync('bash', [join(ROOT, 'infra/allinone/finish.sh'), service, '1', '0'], {
      env: { ...process.env, IA_STATE_DIR: dir, IA_FAILURE_LIMIT: '3', IA_FAILURE_WINDOW: '120', ...env },
      encoding: 'utf8',
    });
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), 'ia-finish-'));
  };
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('tolerates failures below the limit', () => {
    fresh();
    finish('api');
    finish('api');
    expect(existsSync(join(dir, 'fatal'))).toBe(false);
  });

  it('declares the service fatal at the limit and says which', () => {
    fresh();
    for (let i = 0; i < 3; i++) finish('api');
    expect(readFileSync(join(dir, 'fatal'), 'utf8').trim()).toBe('api');
  });

  it('counts each service separately', () => {
    fresh();
    finish('api');
    finish('valkey');
    finish('nginx');
    expect(existsSync(join(dir, 'fatal'))).toBe(false);
  });

  it('forgets failures older than the window', () => {
    fresh();
    const old = Math.floor(Date.now() / 1000) - 1000;
    writeFileSync(join(dir, 'api.failures'), `${old}\n${old + 1}\n`);
    finish('api');
    expect(existsSync(join(dir, 'fatal'))).toBe(false);
  });

  it('never counts a requested stop', () => {
    fresh();
    writeFileSync(join(dir, 'stopping'), '');
    for (let i = 0; i < 5; i++) finish('api');
    expect(existsSync(join(dir, 'fatal'))).toBe(false);
    expect(existsSync(join(dir, 'api.failures'))).toBe(false);
  });
});
