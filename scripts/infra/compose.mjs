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
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'LOG_LEVEL',
  'RATE_LIMIT_DISABLED',
];

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
  // Single replica until the redis presence driver ships (HARDENING section 10; review finding prd-F2).
  lit('PRESENCE_DRIVER', 'memory');
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
