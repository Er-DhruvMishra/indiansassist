#!/usr/bin/env node
// Turns the container's environment and the persisted secrets into every per-service file the all-in-one image needs.
// The pure functions are exported and unit-tested (scripts/test/allinone.test.mjs); main() does the file I/O.
//
//   node render.mjs validate                          check the environment, write nothing
//   node render.mjs render <secrets-file> <0|1>       write the files (second argument: a TLS pair is present)
//
// Nothing here prints a value of a secret: problems name the variable only.

import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Loopback ports, high and unusual on purpose: with `--network host` they share the host's loopback. */
export const PORTS = Object.freeze({
  api: 14000,
  metrics: 19464,
  postgres: 15432,
  valkey: 16379,
  s3: 18333,
  seaweedMaster: 19333,
  seaweedVolume: 18080,
  seaweedFiler: 18888,
});

export const DB_NAME = 'indiansassist';
export const OWNER_ROLE = 'ia_owner';
export const APP_ROLE = 'ia_app';
export const DEFAULT_TRUSTED_PROXIES = Object.freeze(['127.0.0.1/32', '::1/128', '172.16.0.0/12']);

/** Generated once by infra/scripts/init-env.sh; a later boot must find every one of them. */
export const REQUIRED_SECRETS = Object.freeze([
  'POSTGRES_OWNER_PASSWORD',
  'IA_APP_DB_PASSWORD',
  'SESSION_COOKIE_SECRET',
  'TOKEN_SIGNING_KEY',
  'TURN_SECRET',
  'VALKEY_PASSWORD',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'FLEET_DATA_KEY',
  'ORG_SECRETS_KEY',
  'ORG_SECRETS_FP_KEY',
]);

/** Set by the image; a value in the container's environment is ignored (the security properties depend on these). */
export const API_ENV_FIXED = Object.freeze([
  'NODE_ENV',
  'PORT',
  'METRICS_PORT',
  'HOST',
  'API_ORIGIN',
  'WEB_ORIGIN',
  'TRUST_PROXY',
  'DATABASE_URL',
  'MIGRATE_DATABASE_URL',
  'DB_APP_ROLE',
  'SESSION_COOKIE_SECRET',
  'TOKEN_SIGNING_KEY',
  'DEFAULT_REGION',
  'SERVED_REGIONS',
  'TURN_SECRET',
  'PRESENCE_DRIVER',
  'REDIS_URL',
  'STORAGE_DRIVER',
  'STORAGE_FS_DIR',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_FORCE_PATH_STYLE',
  'ORG_SECRETS_KEY',
  'ORG_SECRETS_FP_KEY',
  'FLEET_DATA_KEY',
  'RATE_LIMIT_DISABLED',
]);

/** The image computes a default; a non-empty value in the container's environment replaces it. */
export const API_ENV_DEFAULTED = Object.freeze([
  'REGION_ORIGINS',
  'TURN_URLS',
  'STUN_URLS',
  'ICE_OWN_HOST_SUFFIXES',
  'AGENT_DIST_DIR',
  'AGENT_MSI_DIST_DIR',
]);

/** Passed to the api only when set and non-empty; otherwise the config.ts default applies. */
export const API_ENV_PASSTHROUGH = Object.freeze([
  'TOKEN_SIGNING_KEYS_PREVIOUS',
  'TURN_TTL_SECONDS',
  'AUTH_PROVIDER',
  'LOG_LEVEL',
  'RECORDING_DOWNLOAD_ORIGIN',
  'ORG_STORAGE_QUOTA_BYTES',
  'ORG_MAX_OPEN_UPLOADS',
  'USER_MAX_OPEN_UPLOADS',
  'RECORDING_UPLOAD_WINDOW_SEC',
  'EXTENSION_IDS',
  'EXTENSION_WEBSTORE_URL',
  'EXTENSION_EDGE_URL',
  'EXTENSION_MIN_VERSION',
  'MIRROR_RELAY_BUDGET_BYTES',
  'SIGNUP_PLAN_TIER',
  'RECORDER_TOKEN',
  'AGENT_MIN_VERSION',
  'AGENT_ANDROID_APP_URL',
  'VAULT_ADDR',
  'VAULT_ROLE_ID',
  'VAULT_SECRET_ID',
  'MAIL_DRIVER',
  'SMTP_URL',
  'MAIL_FROM',
  'SMTP_REQUIRE_TLS',
  'DEVICE_HELLO_RATE',
  'WAKE_CONFIRM_SEC',
  'FLEET_DATA_KEYS_PREVIOUS',
  'ORG_SECRETS_KEYS_PREVIOUS',
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
  'BACKUP_RETENTION_DAYS',
]);

export class InputError extends Error {
  constructor(problems) {
    super(problems.join('; '));
    this.name = 'InputError';
    this.problems = problems;
  }
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const REGIONS = ['in-mum', 'eu-fra', 'us-east'];
const truthy = (v) => /^(1|true|yes|on)$/i.test((v ?? '').trim());

function portOf(raw, name, fallback, problems) {
  const v = (raw ?? '').trim();
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push(`${name} must be a port number (1-65535)`);
    return fallback;
  }
  return n;
}

function isCidrOrIp(entry) {
  const [addr, prefix, extra] = entry.split('/');
  const family = isIP(addr ?? '');
  if (family === 0 || extra !== undefined) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/** Validates the container's environment. Collects every problem, then throws InputError. */
export function parseInput(env) {
  const problems = [];
  const domain = (env.IA_DOMAIN ?? '').trim().toLowerCase();
  if (domain === '') problems.push('IA_DOMAIN is required (the public host name, for example in.example.com)');
  else if (!HOSTNAME.test(domain)) problems.push('IA_DOMAIN must be a host name only, with no scheme, port or path');

  const region = (env.IA_REGION ?? '').trim() || 'in-mum';
  if (!REGIONS.includes(region)) problems.push(`IA_REGION must be one of ${REGIONS.join(', ')}`);

  const turnHost = (env.IA_TURN_HOST ?? '').trim().toLowerCase() || domain;
  if (turnHost !== domain && !HOSTNAME.test(turnHost)) problems.push('IA_TURN_HOST must be a host name');

  const publicIp = (env.IA_PUBLIC_IP ?? '').trim();
  if (publicIp !== '' && !publicIp.split('/').every((p, i, all) => all.length <= 2 && isIP(p) !== 0)) {
    problems.push('IA_PUBLIC_IP must be an IP address, or public/private behind 1:1 NAT');
  }

  const proxy = truthy(env.IA_PROXY_MODE);
  const httpPort = portOf(env.IA_HTTP_PORT, 'IA_HTTP_PORT', 8080, problems);
  const httpBind = (env.IA_HTTP_BIND ?? '').trim();
  if (httpBind !== '' && isIP(httpBind) === 0) problems.push('IA_HTTP_BIND must be an IP address');

  const trustedRaw = (env.IA_TRUSTED_PROXIES ?? '').trim();
  const trustedProxies = trustedRaw === '' ? [...DEFAULT_TRUSTED_PROXIES] : trustedRaw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of trustedProxies) if (!isCidrOrIp(t)) problems.push(`IA_TRUSTED_PROXIES entry "${t}" is not an IP or CIDR`);
  if (trustedProxies.length === 0) problems.push('IA_TRUSTED_PROXIES is empty');

  const turnMinPort = portOf(env.TURN_MIN_PORT, 'TURN_MIN_PORT', 49160, problems);
  const turnMaxPort = portOf(env.TURN_MAX_PORT, 'TURN_MAX_PORT', 49200, problems);
  if (turnMinPort > turnMaxPort) problems.push('TURN_MIN_PORT must not be above TURN_MAX_PORT');

  if (problems.length > 0) throw new InputError(problems);
  return { domain, origin: `https://${domain}`, region, turnHost, publicIp, proxy, httpPort, httpBind, trustedProxies, turnMinPort, turnMaxPort };
}

/** KEY=value lines of the secrets file, checked for every required key. Problems name the key, never the value. */
export function parseSecrets(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) values.set(line.slice(0, i), line.slice(i + 1));
  }
  const problems = REQUIRED_SECRETS.filter((k) => !values.get(k)).map((k) => `${k} is missing or empty in the secrets file`);
  if (problems.length > 0) throw new InputError(problems);
  return Object.fromEntries(REQUIRED_SECRETS.map((k) => [k, values.get(k)]));
}

const url = (scheme, user, password, port, path) =>
  `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${path}`;

export const regionOriginsOf = (input, env) => (env.REGION_ORIGINS ?? '').trim() || `${input.region}=${input.origin}`;

/** The api's environment. The owner credential is deliberately absent: `MIGRATE_DATABASE_URL` is empty. */
export function apiEnv(input, secrets, env, certPresent) {
  const host = input.turnHost;
  const turnUrls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
  if (certPresent) turnUrls.push(`turns:${host}:5349`);
  const out = {
    NODE_ENV: 'production',
    PORT: String(PORTS.api),
    METRICS_PORT: String(PORTS.metrics),
    HOST: '127.0.0.1',
    API_ORIGIN: input.origin,
    WEB_ORIGIN: input.origin,
    TRUST_PROXY: 'true',
    DATABASE_URL: url('postgres', APP_ROLE, secrets.IA_APP_DB_PASSWORD, PORTS.postgres, DB_NAME),
    MIGRATE_DATABASE_URL: '',
    DB_APP_ROLE: APP_ROLE,
    SESSION_COOKIE_SECRET: secrets.SESSION_COOKIE_SECRET,
    TOKEN_SIGNING_KEY: secrets.TOKEN_SIGNING_KEY,
    DEFAULT_REGION: input.region,
    SERVED_REGIONS: input.region,
    TURN_SECRET: secrets.TURN_SECRET,
    PRESENCE_DRIVER: 'redis',
    REDIS_URL: url('redis', '', secrets.VALKEY_PASSWORD, PORTS.valkey, '0'),
    STORAGE_DRIVER: 's3',
    STORAGE_FS_DIR: '/data/api/storage',
    S3_ENDPOINT: `http://127.0.0.1:${PORTS.s3}`,
    S3_REGION: 'us-east-1',
    S3_BUCKET: `ia-recordings-${input.region}`,
    S3_ACCESS_KEY: secrets.S3_ACCESS_KEY,
    S3_SECRET_KEY: secrets.S3_SECRET_KEY,
    S3_FORCE_PATH_STYLE: 'true',
    ORG_SECRETS_KEY: secrets.ORG_SECRETS_KEY,
    ORG_SECRETS_FP_KEY: secrets.ORG_SECRETS_FP_KEY,
    FLEET_DATA_KEY: secrets.FLEET_DATA_KEY,
    RATE_LIMIT_DISABLED: 'false',
  };
  const defaults = {
    REGION_ORIGINS: regionOriginsOf(input, env),
    TURN_URLS: turnUrls.join(','),
    STUN_URLS: `stun:${host}:3478`,
    ICE_OWN_HOST_SUFFIXES: input.domain,
    // Release builds an operator copies into the volume; the api re-reads them on SIGHUP or restart.
    AGENT_DIST_DIR: '/data/agent-dist',
    AGENT_MSI_DIST_DIR: '/data/agent-msi',
  };
  for (const [k, v] of Object.entries(defaults)) out[k] = (env[k] ?? '').trim() || v;
  for (const k of API_ENV_PASSTHROUGH) {
    const v = (env[k] ?? '').trim();
    if (v !== '') out[k] = v;
  }
  return out;
}

export function migrateEnv(secrets) {
  return {
    NODE_ENV: 'production',
    MIGRATE_DATABASE_URL: url('postgres', OWNER_ROLE, secrets.POSTGRES_OWNER_PASSWORD, PORTS.postgres, DB_NAME),
    DB_APP_ROLE: APP_ROLE,
  };
}

export function seaweedEnv(input, secrets) {
  const p = PORTS;
  return {
    S3_ACCESS_KEY: secrets.S3_ACCESS_KEY,
    S3_SECRET_KEY: secrets.S3_SECRET_KEY,
    S3_BUCKET: `ia-recordings-${input.region}`,
    SEAWEED_DATA_DIR: '/data/seaweedfs',
    SEAWEED_BIND_IP: '127.0.0.1',
    SEAWEED_S3_PORT: String(p.s3),
    SEAWEED_S3_CONFIG: '/run/ia/seaweedfs/s3.json',
    // -ip is what the volume server registers with the master; without it the master hands out an unbound address.
    SEAWEED_EXTRA_ARGS: `-ip=127.0.0.1 -master.port=${p.seaweedMaster} -volume.port=${p.seaweedVolume} -filer.port=${p.seaweedFiler}`,
  };
}

export function coturnEnv(input, secrets, detectedIp) {
  return {
    TURN_SECRET: secrets.TURN_SECRET,
    TURN_REALM: input.turnHost,
    TURN_EXTERNAL_IP: input.publicIp || detectedIp,
    TURN_MIN_PORT: String(input.turnMinPort),
    TURN_MAX_PORT: String(input.turnMaxPort),
  };
}

export function pgInitEnv(secrets) {
  return {
    POSTGRES_USER: OWNER_ROLE,
    POSTGRES_DB: DB_NAME,
    POSTGRES_PASSWORD: secrets.POSTGRES_OWNER_PASSWORD,
    IA_APP_DB_PASSWORD: secrets.IA_APP_DB_PASSWORD,
    DB_APP_ROLE: APP_ROLE,
    IA_PG_PORT: String(PORTS.postgres),
  };
}

export function healthEnv(input, secrets) {
  return {
    // Both names, as infra/docker-compose.yml does: valkey-cli honours one or the other depending on the release.
    VALKEYCLI_AUTH: secrets.VALKEY_PASSWORD,
    REDISCLI_AUTH: secrets.VALKEY_PASSWORD,
    IA_API_PORT: String(PORTS.api),
    IA_PG_PORT: String(PORTS.postgres),
    IA_VALKEY_PORT: String(PORTS.valkey),
    IA_PROXY_MODE: input.proxy ? '1' : '0',
    IA_HTTP_PORT: String(input.httpPort),
    IA_HEALTH_HOST: input.httpBind && input.httpBind !== '0.0.0.0' && input.httpBind !== '::' ? input.httpBind : '127.0.0.1',
  };
}

/** Rendered as a file read by valkey only, so the password never appears in a process list. */
export function valkeyConf(secrets) {
  if (!/^[A-Za-z0-9._~-]+$/.test(secrets.VALKEY_PASSWORD)) throw new InputError(['VALKEY_PASSWORD holds a character valkey.conf cannot carry']);
  return [
    'bind 127.0.0.1',
    'protected-mode yes',
    `port ${PORTS.valkey}`,
    `requirepass ${secrets.VALKEY_PASSWORD}`,
    'appendonly yes',
    'save 60 1000',
    'dir /data/valkey',
    'daemonize no',
    'logfile ""',
    '',
  ].join('\n');
}

/** `export KEY='value'` lines for a POSIX shell to source. */
export function formatEnvFile(vars) {
  return Object.entries(vars)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new InputError([`${k} must be a single line`]);
      return `export ${k}='${v.replace(/'/g, `'\\''`)}'\n`;
    })
    .join('');
}

/** Written to /run at each start, so the domain lives in no layer of the image. */
export function runtimeConfigJs(input, env) {
  const cfg = { apiUrl: input.origin, regionOrigins: regionOriginsOf(input, env) };
  return `window.__IA_RUNTIME_CONFIG__ = ${JSON.stringify(cfg)};\n`;
}

function replaceOrThrow(text, from, to) {
  if (!text.includes(from)) throw new Error(`nginx template drift: "${from}" not found in web.conf`);
  return text.split(from).join(to);
}

/** Removes the first top-level `server { ... }` (the port 80 redirect) and the comment line above it. */
function withoutFirstServer(text) {
  const m = /^(#[^\n]*\n)?server \{/m.exec(text);
  if (!m) throw new Error('nginx template drift: no server block in web.conf');
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('nginx template drift: unbalanced server block in web.conf');
  return text.slice(0, m.index) + text.slice(i).replace(/^\n+/, '');
}

/**
 * The all-in-one nginx server blocks, derived from the one infra/nginx/web.conf at each start so the locations, limits
 * and headers cannot drift from Compose. Proxy mode serves the same locations on one plain HTTP port.
 */
export function renderWebConf(template, input, { ipv6 = true } = {}) {
  let out = replaceOrThrow(template, 'server api:4000;', `server 127.0.0.1:${PORTS.api};`);
  if (input.proxy) {
    out = withoutFirstServer(out);
    const addr = input.httpBind && isIP(input.httpBind) === 6 ? `[${input.httpBind}]:${input.httpPort}` : input.httpBind ? `${input.httpBind}:${input.httpPort}` : String(input.httpPort);
    out = replaceOrThrow(out, 'listen 443 ssl;', `listen ${addr};`);
    out = replaceOrThrow(out, '  listen [::]:443 ssl;\n', input.httpBind ? '' : `  listen [::]:${input.httpPort};\n`);
    out = replaceOrThrow(out, '  http2 on;\n', '');
    out = replaceOrThrow(out, '  ssl_certificate     /etc/nginx/certs/fullchain.pem;\n', '');
    out = replaceOrThrow(out, '  ssl_certificate_key /etc/nginx/certs/privkey.pem;\n', '');
    // A proxy need not forward the public Host header; the replayer's frame-ancestors must still name it.
    out = replaceOrThrow(out, 'frame-ancestors https://$host', `frame-ancestors https://${input.domain}`);
  }
  if (!ipv6) out = out.replace(/^\s*listen \[::\][^\n]*\n/gm, '');
  return out;
}

/** Proxy mode only: the api must be told the scheme the trusted proxy saw, not this hop's plain http. */
export function renderProxyCommon(template) {
  return replaceOrThrow(template, 'proxy_set_header X-Forwarded-Proto $scheme;', 'proxy_set_header X-Forwarded-Proto $ia_forwarded_proto;');
}

/**
 * Proxy mode only (http context). realip rewrites $remote_addr from X-Forwarded-For for peers in the trusted range, so
 * every limit_req / limit_conn and the X-Forwarded-For sent to the api key on the real client. A peer outside the range
 * has its X-Forwarded-For and X-Forwarded-Proto ignored.
 */
export function renderProxyConf(input) {
  return [
    '# Generated at container start (infra/allinone/render.mjs): the proxy trusted to report the real client.',
    ...input.trustedProxies.map((c) => `set_real_ip_from ${c};`),
    'real_ip_header X-Forwarded-For;',
    'real_ip_recursive on;',
    '',
    'geo $realip_remote_addr $ia_trusted_proxy {',
    '  default 0;',
    ...input.trustedProxies.map((c) => `  ${c} 1;`),
    '}',
    '',
    'map "$ia_trusted_proxy:$http_x_forwarded_proto" $ia_forwarded_proto {',
    '  default $scheme;',
    '  "1:https" https;',
    '  "1:http" http;',
    '}',
    '',
  ].join('\n');
}

/** The first non-internal IPv4 address: a usable TURN external address on a host with a public interface. */
export function detectIp(interfaces = networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

function accountIds(name) {
  const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${name}:`));
  if (!line) throw new Error(`no such user: ${name}`);
  const [, , uid, gid] = line.split(':');
  return [Number(uid), Number(gid)];
}

function put(path, content, { mode = 0o600, owner = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  if (owner) chownSync(path, ...accountIds(owner));
}

function ipv6Available() {
  try {
    return readFileSync('/proc/net/if_inet6', 'utf8').trim() !== '';
  } catch {
    return false;
  }
}

function render(secretsFile, certPresent) {
  const env = process.env;
  const input = parseInput(env);
  const secrets = parseSecrets(readFileSync(secretsFile, 'utf8'));
  const ENV_DIR = '/run/ia/env';
  const envFile = (name, vars) => put(`${ENV_DIR}/${name}.env`, formatEnvFile(vars));

  if (!input.publicIp) {
    console.error('ia-render: IA_PUBLIC_IP is not set; TURN advertises this container\'s own address, so relayed sessions need it set in production');
  }
  envFile('api', apiEnv(input, secrets, env, certPresent));
  envFile('migrate', migrateEnv(secrets));
  envFile('pg-init', pgInitEnv(secrets));
  envFile('postgres', { IA_PG_PORT: String(PORTS.postgres) });
  envFile('seaweedfs', seaweedEnv(input, secrets));
  envFile('seaweedfs-init', { S3_BUCKET: `ia-recordings-${input.region}`, SEAWEED_MASTER: `127.0.0.1:${PORTS.seaweedMaster}` });
  envFile('coturn', coturnEnv(input, secrets, detectIp()));
  envFile('health', healthEnv(input, secrets));
  put('/run/ia/valkey/valkey.conf', valkeyConf(secrets), { owner: 'valkey' });
  put('/run/ia/web/runtime-config.js', runtimeConfigJs(input, env), { mode: 0o644 });

  const webConf = renderWebConf(readFileSync('/ia/nginx/web.conf.template', 'utf8'), input, { ipv6: ipv6Available() });
  put('/etc/nginx/conf.d/web.conf', webConf, { mode: 0o644 });
  const common = readFileSync('/ia/nginx/proxy-common.conf.template', 'utf8');
  put('/etc/nginx/ia/proxy-common.conf', input.proxy ? renderProxyCommon(common) : common, { mode: 0o644 });
  if (input.proxy) put('/etc/nginx/conf.d/00-ia-proxy.conf', renderProxyConf(input), { mode: 0o644 });
  else rmSync('/etc/nginx/conf.d/00-ia-proxy.conf', { force: true });
}

function main(argv) {
  try {
    if (argv[0] === 'validate') {
      parseInput(process.env);
      return 0;
    }
    if (argv[0] === 'render' && argv[1]) {
      render(argv[1], argv[2] === '1');
      return 0;
    }
    console.error('usage: render.mjs validate | render <secrets-file> <0|1>');
    return 2;
  } catch (err) {
    if (err instanceof InputError) {
      for (const p of err.problems) console.error(`ia-render: ${p}`);
      return 1;
    }
    console.error(`ia-render: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
