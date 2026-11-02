// Static checks of infra/docker-compose*.yml against contracts section 11 (Docker is not needed: the files are
// parsed with the `yaml` package). Every check returns a list of problem strings; an empty list means PASS.

import YAML from 'yaml';

/** Compose-specific YAML tags (`!reset`, `!override`) resolve to their plain value. */
const composeTags = [
  { tag: '!reset', collection: 'seq', resolve: (v) => v },
  { tag: '!reset', collection: 'map', resolve: (v) => v },
  { tag: '!override', collection: 'seq', resolve: (v) => v },
  { tag: '!override', collection: 'map', resolve: (v) => v },
];

/** Parses one Compose file. Throws on YAML errors; warnings (e.g. unknown tags) are returned as problems. */
export function parseCompose(text, name = 'compose') {
  const doc = YAML.parseDocument(text, { merge: true, customTags: composeTags });
  if (doc.errors.length > 0) throw new Error(`${name}: ${doc.errors.map((e) => e.message).join('; ')}`);
  const warnings = doc.warnings.map((w) => `${name}: ${w.message.split('\n')[0]}`);
  return { model: doc.toJS({ maxAliasCount: 1000 }), warnings };
}

/** Variable names referenced as ${VAR}, ${VAR:-x}, ${VAR:?x} ... (`$${` escapes are skipped). */
export function interpolatedVars(text) {
  text = stripComments(text);
  const out = new Set();
  const re = /(\$+)\{([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) if (m[1].length % 2 === 1) out.add(m[2]);
  return out;
}

/** Removes full-line and trailing ` # ...` YAML comments (Compose never interpolates comments). */
export function stripComments(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .map((l) => l.replace(/\s+#\s.*$/, ''))
    .join('\n');
}

/** KEY=value lines of an env file (comments and blanks ignored). */
export function parseEnvFile(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out.set(line.slice(0, i).trim(), line.slice(i + 1));
  }
  return out;
}

const envOf = (svc) => {
  const e = svc?.environment ?? {};
  if (!Array.isArray(e)) return e;
  return Object.fromEntries(e.map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')]));
};
const portsOf = (svc) =>
  (svc?.ports ?? []).map((p) => (typeof p === 'string' ? p : `${p.published}:${p.target}/${p.protocol ?? 'tcp'}`));
const listOf = (x) => (Array.isArray(x) ? x : Object.keys(x ?? {}));

/** Contract 11.3 service table. */
export const CONTRACT_SERVICES = {
  postgres: { image: 'postgres:16', internal: true },
  valkey: { image: 'valkey/valkey:8', internal: true },
  coturn: { image: 'coturn/coturn:4.6' },
  seaweedfs: { image: 'chrislusf/seaweedfs:3.80', internal: true },
  api: { internal: true },
  web: {},
  keycloak: { image: 'quay.io/keycloak/keycloak:26.0', internal: true, profile: 'sso' },
};

/** Section 11.1 variables the api must receive in Compose (NODE_ID and PGLITE_DIR are deliberately left out). */
export const API_ENV_VARS = [
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
  'TOKEN_SIGNING_KEYS_PREVIOUS',
  'DEFAULT_REGION',
  'SERVED_REGIONS',
  'REGION_ORIGINS',
  'TURN_SECRET',
  'TURN_URLS',
  'STUN_URLS',
  'ICE_OWN_HOST_SUFFIXES',
  'TURN_TTL_SECONDS',
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
  'AUTH_PROVIDER',
  // Phase E (docs/specs/phase-e-contracts.md section 10)
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
  'LOG_LEVEL',
  'RATE_LIMIT_DISABLED',
  // Phase B (docs/specs/phase-b-contracts.md 11.3)
  'EXTENSION_IDS',
  'EXTENSION_WEBSTORE_URL',
  'EXTENSION_EDGE_URL',
  'EXTENSION_MIN_VERSION',
  'MIRROR_RELAY_BUDGET_BYTES',
  'SIGNUP_PLAN_TIER',
  // Phase F section 3.1a (the C, D and F keys Compose was missing; closes E W89)
  'AGENT_DIST_DIR',
  'AGENT_MSI_DIST_DIR',
  'AGENT_MIN_VERSION',
  'AGENT_ANDROID_APP_URL',
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
];

/**
 * Phase F section 3.1b: `envSchema` keys of apps/api/src/config.ts that Compose deliberately does not pass, because
 * they exist only for development, tests and local fakes (several refuse to boot with NODE_ENV=production).
 */
export const DEV_ONLY_ENV = [
  'NODE_ID',
  'PGLITE_DIR',
  'AGENT_DEV_STUB',
  'EGRESS_ALLOW_HTTP',
  'EGRESS_ALLOW_LOOPBACK',
  'SSO_DEV_DNS_SERVERS',
  'ERASURE_DEV_COOLING_OFF_SEC',
];

/**
 * The keys of the `envSchema` object literal in apps/api/src/config.ts (the text, not the module: the check runs
 * without building the api). Reads the `const envSchema = z.object({ ... });` block, skips comments and nested
 * brackets, and returns every top-level `KEY:` name. Throws when the block cannot be found.
 */
export function configEnvKeys(configText) {
  const start = configText.search(/const\s+envSchema\s*=\s*z\.object\(\s*\{/);
  if (start < 0) throw new Error('config.ts: const envSchema = z.object({ ... }) not found');
  let i = configText.indexOf('{', start) + 1;
  let depth = 1;
  let body = '';
  while (i < configText.length && depth > 0) {
    const two = configText.slice(i, i + 2);
    if (two === '//') {
      const nl = configText.indexOf('\n', i);
      i = nl < 0 ? configText.length : nl;
      continue;
    }
    if (two === '/*') {
      const end = configText.indexOf('*/', i + 2);
      i = end < 0 ? configText.length : end + 2;
      continue;
    }
    const ch = configText[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < configText.length && configText[j] !== ch) j += configText[j] === '\\' ? 2 : 1;
      body += depth === 1 ? '""' : '';
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (depth === 1 || (depth === 0 && ch === '}')) body += ch;
    else if (depth > 1 && body.slice(-1) !== '#') body += '#';
    i++;
  }
  if (depth !== 0) throw new Error('config.ts: envSchema block is not closed');
  const keys = [];
  const re = /(?:^|[,{\s])([A-Z][A-Z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1]);
  if (keys.length === 0) throw new Error('config.ts: envSchema has no keys');
  return keys;
}

/** The keys the Compose `api` service passes in `environment`. */
export function composeApiEnvKeys(text) {
  const { model } = parseCompose(text, 'docker-compose.yml');
  return Object.keys(envOf(model.services?.api));
}

/**
 * Phase F section 3.1b: every `envSchema` key must be passed by the Compose `api` service or be in `DEV_ONLY_ENV`,
 * so a key added to config.ts cannot silently run its default (or fail to boot) in production.
 */
export function checkApiEnvParity(configKeys, composeKeys, devOnly = DEV_ONLY_ENV) {
  const passed = new Set(composeKeys);
  const allowed = new Set(devOnly);
  const problems = [];
  for (const k of configKeys) {
    if (!passed.has(k) && !allowed.has(k)) {
      problems.push(`api: config.ts envSchema key ${k} is not passed by docker-compose.yml (Phase F 3.1b parity)`);
    }
  }
  for (const k of devOnly) {
    if (passed.has(k)) problems.push(`api: ${k} is development only and must not be passed by docker-compose.yml`);
  }
  return problems;
}

const SECRET_KEY = /(PASSWORD|SECRET|TOKEN_SIGNING_KEY$|ACCESS_KEY|ADMIN_TOKEN)/;
const usesVar = (value, name) => new RegExp(`\\$\\{${name}(?=[}:?-])`).test(String(value ?? ''));

/** Checks the main stack file. `envExample` is the parsed infra/.env.example (a Map), or null to skip. */
export function checkMainCompose(text, envExample) {
  const problems = [];
  const { model, warnings } = parseCompose(text, 'docker-compose.yml');
  problems.push(...warnings);
  const services = model.services ?? {};

  for (const [name, spec] of Object.entries(CONTRACT_SERVICES)) {
    const svc = services[name];
    if (!svc) {
      problems.push(`service ${name} is missing (contract 11.3)`);
      continue;
    }
    if (spec.image && svc.image !== spec.image) problems.push(`${name}: image ${svc.image} != ${spec.image}`);
    if (spec.internal && portsOf(svc).length > 0) {
      problems.push(`${name}: publishes ports ${portsOf(svc).join(', ')} but must be internal only`);
    }
    const profiles = svc.profiles ?? [];
    if (spec.profile && !profiles.includes(spec.profile))
      problems.push(`${name}: must be in Compose profile '${spec.profile}'`);
    if (!spec.profile && profiles.length > 0)
      problems.push(`${name}: must run by default (found profiles ${profiles.join(', ')})`);
  }
  for (const name of ['storage-init', 'migrate', 'garage']) {
    if (services[name] && portsOf(services[name]).length > 0) problems.push(`${name}: must not publish ports`);
  }
  if (!services.garage) problems.push('garage: optional service (profile garage) is missing');
  else if (!(services.garage.profiles ?? []).includes('garage')) {
    problems.push('garage: must be opt-in (profile garage); SeaweedFS is the default (contract X6)');
  }

  const webPorts = portsOf(services.web);
  for (const p of ['80:80', '443:443']) if (!webPorts.includes(p)) problems.push(`web: missing port ${p}`);
  const turnPorts = portsOf(services.coturn);
  for (const p of ['3478:3478/udp', '3478:3478/tcp', '5349:5349/tcp', '49160-49200:49160-49200/udp']) {
    if (!turnPorts.includes(p)) problems.push(`coturn: missing port ${p}`);
  }

  const api = envOf(services.api);
  for (const v of API_ENV_VARS) if (!(v in api)) problems.push(`api: environment lacks ${v} (contract 11.1)`);
  const lit = (k, want) => {
    if (String(api[k]) !== want) problems.push(`api: ${k} must be ${want}, found ${api[k]}`);
  };
  lit('NODE_ENV', 'production');
  lit('PORT', '4000');
  lit('TRUST_PROXY', 'true');
  // Valkey presence (contract 10.2, prd-F2): heartbeats and the sweeper lease need it; still one replica until the
  // hub pub/sub bridge ships (HARDENING section 10).
  lit('PRESENCE_DRIVER', 'redis');
  lit('RATE_LIMIT_DISABLED', 'false');
  if (!usesVar(api.API_ORIGIN, 'WEB_ORIGIN') || !usesVar(api.WEB_ORIGIN, 'WEB_ORIGIN')) {
    problems.push('api: API_ORIGIN and WEB_ORIGIN must both come from ${WEB_ORIGIN} (section 11.4)');
  }
  if (!usesVar(api.SERVED_REGIONS, 'DEFAULT_REGION') || String(api.SERVED_REGIONS).includes(',')) {
    problems.push('api: SERVED_REGIONS must be exactly the stack region ${DEFAULT_REGION} (R2)');
  }
  if (!/@postgres:5432\//.test(String(api.DATABASE_URL)) || !usesVar(api.DATABASE_URL, 'DB_APP_ROLE')) {
    problems.push('api: DATABASE_URL must connect as ${DB_APP_ROLE} to postgres:5432');
  }
  if (!usesVar(api.REDIS_URL, 'VALKEY_PASSWORD') || !String(api.REDIS_URL).includes('@valkey:6379')) {
    problems.push('api: REDIS_URL must point at valkey:6379 with the Valkey password');
  }
  if (Object.values(api).some((v) => usesVar(v, 'POSTGRES_OWNER_PASSWORD'))) {
    problems.push(
      'api: must not receive the owner credential; only the one-shot migrate service uses it (append-only role)',
    );
  }
  if (!usesVar(envOf(services.migrate).MIGRATE_DATABASE_URL, 'POSTGRES_OWNER_PASSWORD')) {
    problems.push('migrate: MIGRATE_DATABASE_URL must use the owner role');
  }
  // Phase F section 3.1a: the fleet key is required (no silent dev default in production), and the agent builds come
  // from read-only mounts.
  if (!/^\$\{FLEET_DATA_KEY:\?/.test(String(api.FLEET_DATA_KEY ?? ''))) {
    problems.push('api: FLEET_DATA_KEY must be required (${FLEET_DATA_KEY:?...}) (Phase F 3.1a)');
  }
  lit('AGENT_DIST_DIR', '/data/agent-dist');
  lit('AGENT_MSI_DIST_DIR', '/data/agent-msi');
  const apiVols = (services.api?.volumes ?? []).map((v) => (typeof v === 'string' ? v : `${v.source}:${v.target}`));
  for (const [src, dst] of [
    ['./data/agent-dist', '/data/agent-dist'],
    ['./data/agent-msi', '/data/agent-msi'],
  ]) {
    if (!apiVols.includes(`${src}:${dst}:ro`)) problems.push(`api: must mount ${src}:${dst}:ro (Phase F 3.1a)`);
  }
  if (!String(api.S3_ENDPOINT).includes('http://seaweedfs:8333')) {
    problems.push('api: S3_ENDPOINT must default to the seaweedfs service (contract X6)');
  }

  // TURN secret wiring: one variable feeds both the api (credential signing) and coturn (static-auth-secret).
  const turn = envOf(services.coturn);
  if (!usesVar(api.TURN_SECRET, 'TURN_SECRET')) problems.push('api: TURN_SECRET must come from ${TURN_SECRET}');
  if (!usesVar(turn.TURN_SECRET, 'TURN_SECRET')) problems.push('coturn: TURN_SECRET must come from ${TURN_SECRET}');
  if (!/\$\{TURN_SECRET:\?/.test(text)) problems.push('TURN_SECRET must be required (${TURN_SECRET:?...})');
  for (const k of ['TURN_REALM', 'TURN_EXTERNAL_IP'])
    if (!usesVar(turn[k], k)) problems.push(`coturn: ${k} must come from \${${k}}`);

  for (const [name, svc] of Object.entries(services)) {
    for (const [k, v] of Object.entries(envOf(svc))) {
      if (SECRET_KEY.test(k) && v !== null && String(v) !== '' && !String(v).includes('${')) {
        problems.push(`${name}: ${k} has a literal value; secrets must come from infra/.env`);
      }
    }
  }

  const nets = new Set(Object.keys(model.networks ?? {}));
  const vols = new Set(Object.keys(model.volumes ?? {}));
  for (const [name, svc] of Object.entries(services)) {
    for (const d of listOf(svc.depends_on)) if (!services[d]) problems.push(`${name}: depends_on unknown service ${d}`);
    for (const n of listOf(svc.networks)) if (!nets.has(n)) problems.push(`${name}: unknown network ${n}`);
    for (const v of svc.volumes ?? []) {
      const src = typeof v === 'string' ? v.split(':')[0] : v.source;
      if (src && !src.startsWith('.') && !src.startsWith('/') && !vols.has(src))
        problems.push(`${name}: unknown volume ${src}`);
    }
  }
  if (model.networks?.backend?.internal !== true) problems.push('networks.backend must be internal: true');
  if (listOf(services.coturn?.networks).includes('backend')) problems.push('coturn must not join the backend network');
  if (listOf(services.api?.networks).includes('edge')) problems.push('api must not join the edge network');

  if (envExample) {
    for (const v of interpolatedVars(text)) {
      if (!envExample.has(v)) problems.push(`\${${v}} is used but not documented in infra/.env.example`);
    }
  }
  return problems;
}

/** Checks the production coturn override (host networking, full relay range). */
export function checkTurnHostCompose(text) {
  const problems = [];
  const { model, warnings } = parseCompose(text, 'docker-compose.turn-host.yml');
  problems.push(...warnings);
  const c = model.services?.coturn;
  if (!c) return [...problems, 'turn-host: no coturn service'];
  if (c.network_mode !== 'host') problems.push('turn-host: coturn must use network_mode: host');
  if (listOf(c.ports).length > 0) problems.push('turn-host: coturn ports must be reset');
  if (listOf(c.networks).length > 0) problems.push('turn-host: coturn networks must be reset');
  if (!/ports:\s*!reset/.test(text) || !/networks:\s*!reset/.test(text))
    problems.push('turn-host: expected !reset on ports and networks');
  const extra = Object.keys(model.services ?? {}).filter((s) => s !== 'coturn');
  if (extra.length > 0) problems.push(`turn-host: unexpected services ${extra.join(', ')}`);
  return problems;
}
