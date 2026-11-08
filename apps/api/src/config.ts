/**
 * API configuration from the environment (contracts section 11.1). Every variable has a development default so the
 * api starts with zero env vars; `NODE_ENV=production` makes the "prod: required" secrets mandatory and enforces
 * the production refinements (DB_APP_ROLE, secrets, TURN_SECRET with TURN_URLS, WEB_ORIGIN === API_ORIGIN, https
 * origins, exactly one SERVED_REGIONS). `./data/*` paths are resolved against the repo root.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_VERSION_RE,
  DEFAULT_REGION,
  isRegion,
  LIMITS,
  PACKAGE_TIERS,
  parseRegionList,
  parseRegionOrigins,
  splitUrlList,
  type PackageTier,
  type Region,
} from '@indiansassist/shared';
import { z } from 'zod';

/** Walks up from this module (then the cwd) to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  for (const from of [start, process.cwd()]) {
    let dir = from;
    for (let i = 0; i < 10; i++) {
      if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : /^(1|true|yes|on)$/i.test(v.trim())));
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.trim()));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: `expected a non-negative integer, got ${v}` });
        return z.NEVER;
      }
      return n;
    });

const DEFAULT_MAIL_FROM = 'IndiansAssist <no-reply@localhost>';

/** True when an SMTP URL's host is a loopback name or address (section 4.1b). */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: str('development'),
  PORT: int(4000),
  METRICS_PORT: int(9464),
  HOST: str('0.0.0.0'),
  NODE_ID: str(''),
  API_ORIGIN: str('http://localhost:4000'),
  WEB_ORIGIN: str('http://localhost:5173'),
  TRUST_PROXY: bool(false),
  DATABASE_URL: str(''),
  MIGRATE_DATABASE_URL: str(''),
  PGLITE_DIR: str('./data/pglite'),
  DB_APP_ROLE: str(''),
  SESSION_COOKIE_SECRET: str(''),
  TOKEN_SIGNING_KEY: str(''),
  TOKEN_SIGNING_KEYS_PREVIOUS: str(''),
  DEFAULT_REGION: str(DEFAULT_REGION),
  SERVED_REGIONS: str(''),
  REGION_ORIGINS: str('in-mum=http://localhost:5173,eu-fra=http://localhost:5173,us-east=http://localhost:5173'),
  TURN_SECRET: str('dev-turn-secret'),
  TURN_URLS: str(''),
  STUN_URLS: str(''),
  ICE_OWN_HOST_SUFFIXES: str(''),
  TURN_TTL_SECONDS: int(3600),
  PRESENCE_DRIVER: z.enum(['memory', 'redis']).optional().default('memory'),
  REDIS_URL: str(''),
  STORAGE_DRIVER: z.enum(['fs', 's3']).optional().default('fs'),
  STORAGE_FS_DIR: str('./data/storage'),
  S3_ENDPOINT: str(''),
  S3_REGION: str(''),
  S3_BUCKET: str(''),
  S3_ACCESS_KEY: str(''),
  S3_SECRET_KEY: str(''),
  S3_FORCE_PATH_STYLE: bool(true),
  /** Phase E W86: only `local`; any other value is a boot problem naming docs/specs/phase-e-contracts.md section 3.10. */
  AUTH_PROVIDER: str('local'),
  LOG_LEVEL: str('info'),
  RATE_LIMIT_DISABLED: bool(false),
  RECORDING_DOWNLOAD_ORIGIN: str(''),
  ORG_STORAGE_QUOTA_BYTES: int(50 * 1024 ** 3),
  ORG_MAX_OPEN_UPLOADS: int(10),
  USER_MAX_OPEN_UPLOADS: int(3),
  RECORDING_UPLOAD_WINDOW_SEC: int(24 * 60 * 60),
  // Phase B (docs/specs/phase-b-contracts.md sections 2.4, 4.6, 11.3, Y21)
  EXTENSION_IDS: str(''),
  EXTENSION_WEBSTORE_URL: str(''),
  EXTENSION_EDGE_URL: str(''),
  EXTENSION_MIN_VERSION: str('0.2.0'),
  MIRROR_RELAY_BUDGET_BYTES: int(LIMITS.mirrorRelayBudgetBytes),
  SIGNUP_PLAN_TIER: z.enum(PACKAGE_TIERS).optional().default('p2_extension'),
  // Phase A.2 (docs/specs/phase-a2-recorder.md section 13): empty = server recorder disabled.
  RECORDER_TOKEN: str(''),
  // Phase C (docs/specs/phase-c-contracts.md sections 2.2, 2.6, 13.3)
  AGENT_DIST_DIR: str('./data/agent-dist'),
  AGENT_MIN_VERSION: str('0.3.0'),
  AGENT_ANDROID_APP_URL: str(''),
  /** Dev only: a placeholder file served as every Windows build when AGENT_DIST_DIR has no manifest ('' = off). */
  AGENT_DEV_STUB: z.string().optional(),
  // Phase D (docs/specs/phase-d-contracts.md sections 6.4d, 8.2c, 9.8, 13.5, 16.1)
  AGENT_MSI_DIST_DIR: str('./data/agent-msi'),
  /** 32 bytes hex, optionally `<keyId>:<hex>`; encrypts device MACs at rest (rule 8.2c). Dev: persisted under ./data. */
  FLEET_DATA_KEY: str(''),
  VAULT_ADDR: str(''),
  VAULT_ROLE_ID: str(''),
  VAULT_SECRET_ID: str(''),
  MAIL_DRIVER: z.enum(['log', 'smtp']).optional().default('log'),
  SMTP_URL: str(''),
  MAIL_FROM: str(DEFAULT_MAIL_FROM),
  DEVICE_HELLO_RATE: int(500),
  WAKE_CONFIRM_SEC: int(LIMITS.wakeConfirmSec),
  // Phase E (docs/specs/phase-e-contracts.md sections 2.1, 2.2, 5.2a, 10)
  /** `<keyId>:<64 hex>`; seals org secrets at rest. Dev: generated and persisted to ./data/org-secrets.key. */
  ORG_SECRETS_KEY: str(''),
  /** Comma list of `<keyId>:<64 hex>`, used only to open (rotation). */
  ORG_SECRETS_KEYS_PREVIOUS: str(''),
  /** 64 hex; keys the secret fingerprints; never rotated. Dev: persisted to ./data/org-secrets-fp.key. */
  ORG_SECRETS_FP_KEY: str(''),
  EGRESS_PRIVATE_ALLOW: str(''),
  EGRESS_METADATA_ADDRESSES: str(''),
  EGRESS_ALLOW_HTTP: bool(false),
  EGRESS_ALLOW_LOOPBACK: bool(false),
  /** Development only: `host:port` list of DNS servers for the SSO domain TXT proof (a local fake). Phase E §10. */
  SSO_DEV_DNS_SERVERS: str(''),
  AI_LOCAL_ENDPOINTS: str(''),
  AI_LOCAL_MODEL: str('local'),
  AI_LOCAL_API_KEY: str(''),
  AI_LOCAL_TIMEOUT_MS: int(60_000),
  AI_ANTHROPIC_API_KEY: str(''),
  AI_ANTHROPIC_REGIONS: str(''),
  AI_ANTHROPIC_MODEL: str('claude-opus-5-5'),
  AI_ANTHROPIC_TIMEOUT_MS: int(90_000),
  AI_ANTHROPIC_MAX_RETRIES: int(0),
  // Phase F (docs/specs/phase-f-contracts.md sections 3.1c, 4.1b, 5.2c, 11)
  /** Comma list of `<keyId>:<64 hex>`, open-only (fleet-key rotation, section 3.1c). */
  FLEET_DATA_KEYS_PREVIOUS: str(''),
  /** Unset: true in production, else false (section 4.1b). */
  SMTP_REQUIRE_TLS: z.string().optional(),
  /** Development only: a positive integer of seconds replaces the 7-day cooling-off (section 5.2c). */
  ERASURE_DEV_COOLING_OFF_SEC: str(''),
  /** The operator's backup retention in days, stated in the erasure certificate ('' = not stated). */
  BACKUP_RETENTION_DAYS: str(''),
});

export type Env = z.output<typeof envSchema>;

export type Config = {
  nodeEnv: string;
  production: boolean;
  port: number;
  metricsPort: number;
  host: string;
  nodeId: string;
  apiOrigin: string;
  webOrigin: string;
  trustProxy: boolean;
  databaseUrl: string;
  migrateDatabaseUrl: string;
  pgliteDir: string;
  dbAppRole: string;
  sessionCookieSecret: string;
  tokenSigningKey: string;
  /** Retired public keys, base64url. */
  tokenSigningKeysPrevious: string[];
  defaultRegion: Region;
  servedRegions: Region[];
  regionOrigins: Partial<Record<Region, string>>;
  turnSecret: string;
  turnUrls: string[];
  stunUrls: string[];
  iceOwnHostSuffixes: string[];
  turnTtlSeconds: number;
  presenceDriver: 'memory' | 'redis';
  redisUrl: string;
  storageDriver: 'fs' | 's3';
  storageFsDir: string;
  s3: { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
  /** Phase E W86: the password provider only; per-org SSO lives in `apps/api/src/sso`. */
  authProvider: 'local';
  logLevel: string;
  rateLimitDisabled: boolean;
  /** Storage quotas (section 6.10): bytes per org (0 = unlimited), open uploads per org / user, upload window. */
  /** Origin of the fs driver's signed `/file` URLs (SEC-01); defaults to API_ORIGIN. */
  recordingDownloadOrigin: string;
  recordingQuota: { orgBytes: number; orgOpenUploads: number; userOpenUploads: number; uploadWindowSec: number };
  /** Phase B: listed extension ids (also the Y21 Origin allow-list) and the install info of `PublicToken.extension`. */
  extension: { ids: string[]; webStoreUrl: string | null; edgeAddonsUrl: string | null; minVersion: string };
  /** Per-session WS mirror relay budget: `data` characters per sliding 10 s (Phase B 4.6). */
  mirrorRelayBudgetBytes: number;
  /** `org.plan_tier` of orgs created by signup (billing is out of scope; Phase B ships P2). */
  signupPlanTier: PackageTier;
  /** Phase A.2 service token of the server recorder; '' = recorder disabled. */
  recorderToken: string;
  /** Phase C: agent builds (`manifest.json` + files), the minimum agent version and the Android store link. */
  agent: { distDir: string; minVersion: string; androidAppUrl: string | null; devStub: string | null };
  /**
   * Phase D: the fleet data key (MACs at rest), branded MSI artifacts, wake confirmation window, hello rate. Phase F
   * section 3.1c: `previousKeys`, the open-only keys of `FLEET_DATA_KEYS_PREVIOUS`.
   */
  fleet: {
    dataKey: Buffer;
    dataKeyId: string;
    previousKeys: { keyId: string; key: Buffer }[];
    msiDistDir: string;
    wakeConfirmSec: number;
    deviceHelloRate: number;
  };
  /** Phase D rule 6.4d: the consent-receipt mailer; Phase F section 4.1b `requireTls`. */
  mail: { driver: 'log' | 'smtp'; smtpUrl: string; from: string; requireTls: boolean };
  /** Phase F section 5.2c: the development cooling-off override (null = the contract's days). */
  erasure: { devCoolingOffSec: number | null };
  /** Phase F section 11: `BACKUP_RETENTION_DAYS` (null = not stated). */
  backupRetentionDays: number | null;
  /** Phase D rule 9.8: the credential vault (OpenBao / Vault AppRole); '' addr = not configured. */
  vault: { addr: string; roleId: string; secretId: string };
  /** Phase E section 2.1: the org-secret key (current), the open-only previous keys and the fingerprint key. */
  orgSecrets: OrgSecretsConfig;
  /** Phase E section 2.2: the egress guard's operator settings. */
  egress: EgressConfig;
  /** Phase E section 5.2a: operator AI configuration, per region, never per org. */
  ai: AiConfig;
  repoRoot: string;
  /** Where dev secrets are persisted (`./data`). */
  dataDir: string;
};

export type OrgSecretsConfig = {
  keyId: string;
  key: Buffer;
  /** Open-only keys (`ORG_SECRETS_KEYS_PREVIOUS`). */
  previous: { keyId: string; key: Buffer }[];
  /** 32 bytes; `HMAC-SHA256(fpKey, plaintext)` fingerprints (section 2.1). */
  fpKey: Buffer;
};

/** One `EGRESS_PRIVATE_ALLOW` entry: an exact host name or a CIDR, each with a port (default 443 for a host). */
export type EgressAllowEntry = { kind: 'host'; host: string; port: number } | { kind: 'cidr'; cidr: string; port: number };

export type EgressConfig = {
  allowHttp: boolean;
  allowLoopback: boolean;
  privateAllow: EgressAllowEntry[];
  /** Extra metadata addresses refused always (beyond the built-in list of section 2.2 G2). */
  metadataAddresses: string[];
  /**
   * `SSO_DEV_DNS_SERVERS`: DNS servers (`host:port`) the SSO domain TXT proof uses instead of the system resolver,
   * so a local fake can publish a record. Empty in production (a boot problem otherwise) and without loopback egress.
   */
  devDnsServers?: string[];
};

export type AiConfig = {
  local: { endpoints: Partial<Record<Region, string>>; model: string; apiKey: string; timeoutMs: number };
  anthropic: { apiKey: string; regions: Region[]; model: string; timeoutMs: number; maxRetries: number };
};

const KEYED_HEX64 = /^([A-Za-z0-9_-]{1,16}):([0-9a-fA-F]{64})$/;

/** Parses `EGRESS_PRIVATE_ALLOW` (section 2.2 G2): `host[:port]` or `CIDR:port`; throws naming the bad entry. */
export function parseEgressAllow(value: string): EgressAllowEntry[] {
  const out: EgressAllowEntry[] = [];
  for (const raw of value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const cidr = /^([0-9a-fA-F:.]+\/\d{1,3}):(\d{1,5})$/.exec(raw);
    if (cidr) {
      const port = Number(cidr[2]);
      if (port < 1 || port > 65535) throw new Error(`EGRESS_PRIVATE_ALLOW entry ${raw} has a bad port`);
      out.push({ kind: 'cidr', cidr: cidr[1]!, port });
      continue;
    }
    if (raw.includes('/')) throw new Error(`EGRESS_PRIVATE_ALLOW entry ${raw} must be CIDR:port`);
    const hp = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(raw);
    if (!hp) throw new Error(`EGRESS_PRIVATE_ALLOW entry ${raw} is not host[:port] or CIDR:port`);
    const port = hp[2] ? Number(hp[2]) : 443;
    if (port < 1 || port > 65535) throw new Error(`EGRESS_PRIVATE_ALLOW entry ${raw} has a bad port`);
    out.push({ kind: 'host', host: hp[1]!.toLowerCase(), port });
  }
  return out;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type LoadConfigOptions = {
  repoRoot?: string;
  /** Persist auto-generated dev secrets under `<repoRoot>/data` (default true). Tests pass false. */
  persistSecrets?: boolean;
};

function readOrCreateSecret(file: string, make: () => string, validate: (s: string) => boolean, persist: boolean): string {
  if (persist && existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim();
    if (validate(v)) return v;
  }
  const v = make();
  if (persist) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, v + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  return v;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * What the api does about migrations at boot: `owner` runs them on a separate owner connection, `same` on the app's
 * own connection (dev, PGlite), and `none` leaves them to the deployment's migrate step (a Postgres api with no owner
 * URL, the production Compose stack: its `migrate` service finishes before the api starts).
 */
export function bootMigration(config: Pick<Config, 'databaseUrl' | 'migrateDatabaseUrl'>): 'owner' | 'same' | 'none' {
  if (config.migrateDatabaseUrl === '') return config.databaseUrl === '' ? 'same' : 'none';
  return config.migrateDatabaseUrl === config.databaseUrl ? 'same' : 'owner';
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env, opts: LoadConfigOptions = {}): Config {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const persist = opts.persistSecrets ?? true;
  const dataDir = resolve(repoRoot, 'data');
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(repoRoot, p));
  const problems: string[] = [];

  let servedRegions: Region[] = [];
  let regionOrigins: Partial<Record<Region, string>> = {};
  try {
    servedRegions = parseRegionList(e.SERVED_REGIONS);
    regionOrigins = parseRegionOrigins(e.REGION_ORIGINS);
  } catch (err) {
    problems.push((err as Error).message);
  }
  const defaultRegion: Region = isRegion(e.DEFAULT_REGION) ? e.DEFAULT_REGION : DEFAULT_REGION;
  if (!isRegion(e.DEFAULT_REGION)) problems.push(`DEFAULT_REGION ${e.DEFAULT_REGION} is not a region`);

  let cookieSecret = e.SESSION_COOKIE_SECRET;
  if (cookieSecret === '') {
    if (production) problems.push('SESSION_COOKIE_SECRET is required in production');
    cookieSecret = readOrCreateSecret(
      resolve(dataDir, 'cookie.secret'),
      () => randomBytes(32).toString('base64url'),
      (s) => s.length >= 32,
      persist,
    );
  } else if (production && cookieSecret.length < 32) problems.push('SESSION_COOKIE_SECRET must be >= 32 chars');

  let signingKey = e.TOKEN_SIGNING_KEY;
  if (signingKey === '') {
    if (production) problems.push('TOKEN_SIGNING_KEY is required in production');
    signingKey = readOrCreateSecret(
      resolve(dataDir, 'signing.key'),
      () => randomBytes(32).toString('hex'),
      (s) => HEX64.test(s),
      persist,
    );
  }
  if (!HEX64.test(signingKey)) problems.push('TOKEN_SIGNING_KEY must be 64 hex chars');

  const turnUrls = splitUrlList(e.TURN_URLS);
  const apiOrigin = e.API_ORIGIN.replace(/\/+$/, '');
  const webOrigin = e.WEB_ORIGIN.replace(/\/+$/, '');
  let apiHost = 'localhost';
  try {
    apiHost = new URL(apiOrigin).hostname;
  } catch {
    problems.push('API_ORIGIN is not a URL');
  }
  const downloadOrigin = e.RECORDING_DOWNLOAD_ORIGIN !== '' ? e.RECORDING_DOWNLOAD_ORIGIN.replace(/\/+$/, '') : apiOrigin;
  try {
    if (new URL(downloadOrigin).origin !== downloadOrigin) problems.push('RECORDING_DOWNLOAD_ORIGIN must be an origin (no path)');
  } catch {
    problems.push('RECORDING_DOWNLOAD_ORIGIN is not a URL');
  }
  if (production) {
    if (!downloadOrigin.startsWith('https:')) problems.push('RECORDING_DOWNLOAD_ORIGIN must be https: in production');
    if (e.DB_APP_ROLE === '') problems.push('DB_APP_ROLE is required in production');
    if (turnUrls.length > 0 && e.TURN_SECRET.length < 32)
      problems.push('TURN_SECRET must be >= 32 chars when TURN_URLS is set');
    if (webOrigin !== apiOrigin) problems.push('WEB_ORIGIN must equal API_ORIGIN in production');
    if (!webOrigin.startsWith('https:') || !apiOrigin.startsWith('https:'))
      problems.push('WEB_ORIGIN and API_ORIGIN must be https: in production');
    if (servedRegions.length !== 1) problems.push('SERVED_REGIONS must name exactly one region in production');
    if (e.RECORDER_TOKEN !== '' && e.RECORDER_TOKEN.length < LIMITS.recorderTokenMinProd)
      problems.push(`RECORDER_TOKEN must be >= ${LIMITS.recorderTokenMinProd} chars when set`);
  }
  if (e.PRESENCE_DRIVER === 'redis' && e.REDIS_URL === '') problems.push('REDIS_URL is required with redis presence');
  if (e.STORAGE_DRIVER === 's3') {
    for (const k of ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const)
      if (e[k] === '') problems.push(`${k} is required with the s3 storage driver`);
  }
  const extensionIds = splitUrlList(e.EXTENSION_IDS);
  for (const id of extensionIds) if (!/^[a-p]{32}$/.test(id)) problems.push(`EXTENSION_IDS entry ${id} is not a Chrome extension id`);
  if (!AGENT_VERSION_RE.test(e.AGENT_MIN_VERSION)) problems.push('AGENT_MIN_VERSION must be MAJOR.MINOR.PATCH');
  if (e.AGENT_ANDROID_APP_URL !== '' && !/^https:\/\//.test(e.AGENT_ANDROID_APP_URL) && production)
    problems.push('AGENT_ANDROID_APP_URL must be https: in production');
  // Phase D rule 8.2c: the fleet data key (dev: generated and persisted like the other dev secrets).
  let fleetKeyRaw = e.FLEET_DATA_KEY;
  if (fleetKeyRaw === '') {
    if (production) problems.push('FLEET_DATA_KEY is required in production');
    fleetKeyRaw = readOrCreateSecret(resolve(dataDir, 'fleet-data.key'), () => randomBytes(32).toString('hex'), (s) => HEX64.test(s), persist);
  }
  const fleetKeyMatch = /^(?:([A-Za-z0-9_-]{1,16}):)?([0-9a-fA-F]{64})$/.exec(fleetKeyRaw);
  if (!fleetKeyMatch) problems.push('FLEET_DATA_KEY must be 64 hex chars, optionally prefixed with "<keyId>:"');
  // Phase F section 3.1c: open-only previous fleet keys; with any, the current key names its id explicitly.
  const previousFleetKeys: { keyId: string; key: Buffer }[] = [];
  for (const entry of splitUrlList(e.FLEET_DATA_KEYS_PREVIOUS)) {
    const m = KEYED_HEX64.exec(entry);
    if (!m) problems.push('FLEET_DATA_KEYS_PREVIOUS entries must be "<keyId>:<64 hex>"');
    else if (fleetKeyMatch?.[1] !== undefined && m[1] === fleetKeyMatch[1])
      problems.push(`FLEET_DATA_KEYS_PREVIOUS repeats the current key id ${m[1]}`);
    else if (previousFleetKeys.some((k) => k.keyId === m[1])) problems.push(`FLEET_DATA_KEYS_PREVIOUS repeats the key id ${m[1]}`);
    else previousFleetKeys.push({ keyId: m[1]!, key: Buffer.from(m[2]!, 'hex') });
  }
  if (splitUrlList(e.FLEET_DATA_KEYS_PREVIOUS).length > 0 && fleetKeyMatch && fleetKeyMatch[1] === undefined)
    problems.push('FLEET_DATA_KEY must carry an explicit "<keyId>:" prefix when FLEET_DATA_KEYS_PREVIOUS is set');
  if (e.MAIL_DRIVER === 'smtp' && e.SMTP_URL === '') problems.push('SMTP_URL is required with MAIL_DRIVER=smtp');
  // Phase F section 4.1b: TLS to the SMTP relay is required in production unless the relay is on loopback.
  const smtpRequireTls =
    e.SMTP_REQUIRE_TLS === undefined || e.SMTP_REQUIRE_TLS.trim() === ''
      ? production
      : /^(1|true|yes|on)$/i.test(e.SMTP_REQUIRE_TLS.trim());
  if (production && e.MAIL_DRIVER === 'smtp' && !smtpRequireTls && e.SMTP_URL !== '' && !isLoopbackUrl(e.SMTP_URL))
    problems.push('SMTP_REQUIRE_TLS=false needs a loopback SMTP host with NODE_ENV=production');
  // Phase F section 5.2c: the cooling-off override exists only for development tests and smokes.
  let erasureDevCoolingOffSec: number | null = null;
  if (e.ERASURE_DEV_COOLING_OFF_SEC !== '') {
    const n = Number(e.ERASURE_DEV_COOLING_OFF_SEC);
    if (production) problems.push('ERASURE_DEV_COOLING_OFF_SEC must not be set with NODE_ENV=production');
    else if (!Number.isInteger(n) || n <= 0) problems.push('ERASURE_DEV_COOLING_OFF_SEC must be a positive integer of seconds');
    else erasureDevCoolingOffSec = n;
  }
  let backupRetentionDays: number | null = null;
  if (e.BACKUP_RETENTION_DAYS !== '') {
    const n = Number(e.BACKUP_RETENTION_DAYS);
    if (!Number.isInteger(n) || n <= 0 || n > 36_500) problems.push('BACKUP_RETENTION_DAYS must be a positive integer of days');
    else backupRetentionDays = n;
  }
  if (e.VAULT_ADDR !== '' && (e.VAULT_ROLE_ID === '' || e.VAULT_SECRET_ID === ''))
    problems.push('VAULT_ROLE_ID and VAULT_SECRET_ID are required with VAULT_ADDR');
  // Phase E W86: the oidc stub and AUTH_PROVIDER=oidc are retired.
  if (e.AUTH_PROVIDER !== 'local')
    problems.push(`AUTH_PROVIDER must be local (got ${e.AUTH_PROVIDER}); per-org SSO replaces it, docs/specs/phase-e-contracts.md section 3.10`);
  // Phase E section 2.1: the org-secret keys (dev: generated and persisted like the other dev secrets).
  let orgKeyRaw = e.ORG_SECRETS_KEY;
  if (orgKeyRaw === '') {
    if (production) problems.push('ORG_SECRETS_KEY is required in production');
    orgKeyRaw = readOrCreateSecret(resolve(dataDir, 'org-secrets.key'), () => `k1:${randomBytes(32).toString('hex')}`, (s) => KEYED_HEX64.test(s), persist);
  }
  const orgKeyMatch = KEYED_HEX64.exec(orgKeyRaw);
  if (!orgKeyMatch) problems.push('ORG_SECRETS_KEY must be "<keyId>:<64 hex>" (keyId 1..16 of [A-Za-z0-9_-])');
  const previousOrgKeys: { keyId: string; key: Buffer }[] = [];
  for (const entry of splitUrlList(e.ORG_SECRETS_KEYS_PREVIOUS)) {
    const m = KEYED_HEX64.exec(entry);
    if (!m) problems.push('ORG_SECRETS_KEYS_PREVIOUS entries must be "<keyId>:<64 hex>"');
    else if (orgKeyMatch && m[1] === orgKeyMatch[1]) problems.push(`ORG_SECRETS_KEYS_PREVIOUS repeats the current key id ${m[1]}`);
    else previousOrgKeys.push({ keyId: m[1]!, key: Buffer.from(m[2]!, 'hex') });
  }
  let fpKeyRaw = e.ORG_SECRETS_FP_KEY;
  if (fpKeyRaw === '') {
    if (production) problems.push('ORG_SECRETS_FP_KEY is required in production');
    fpKeyRaw = readOrCreateSecret(resolve(dataDir, 'org-secrets-fp.key'), () => randomBytes(32).toString('hex'), (s) => HEX64.test(s), persist);
  }
  if (!HEX64.test(fpKeyRaw)) problems.push('ORG_SECRETS_FP_KEY must be 64 hex chars');
  // Phase E section 2.2 G1/G2: the loosening switches never combine with production.
  if (production && e.EGRESS_ALLOW_HTTP) problems.push('EGRESS_ALLOW_HTTP must not be set with NODE_ENV=production');
  if (production && e.EGRESS_ALLOW_LOOPBACK) problems.push('EGRESS_ALLOW_LOOPBACK must not be set with NODE_ENV=production');
  // A fake DNS server would let anyone "prove" any domain, so this seam never exists in production.
  const devDnsServers = e.SSO_DEV_DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (devDnsServers.length > 0) {
    if (production) problems.push('SSO_DEV_DNS_SERVERS must not be set with NODE_ENV=production');
    if (!e.EGRESS_ALLOW_LOOPBACK) problems.push('SSO_DEV_DNS_SERVERS needs EGRESS_ALLOW_LOOPBACK=1 (it exists only for local fakes)');
    for (const s of devDnsServers) {
      if (!/^[A-Za-z0-9.-]+:\d{1,5}$|^\[[0-9A-Fa-f:]+\]:\d{1,5}$/.test(s)) problems.push(`SSO_DEV_DNS_SERVERS entry "${s}" must be host:port`);
    }
  }
  let egressAllow: EgressAllowEntry[] = [];
  try {
    egressAllow = parseEgressAllow(e.EGRESS_PRIVATE_ALLOW);
  } catch (err) {
    problems.push((err as Error).message);
  }
  // Phase E section 5.2a: operator AI configuration (an unknown region code is a boot problem).
  let aiLocalEndpoints: Partial<Record<Region, string>> = {};
  try {
    aiLocalEndpoints = parseRegionOrigins(e.AI_LOCAL_ENDPOINTS);
  } catch (err) {
    problems.push(`AI_LOCAL_ENDPOINTS: ${(err as Error).message}`);
  }
  for (const [region, url] of Object.entries(aiLocalEndpoints)) {
    if (!/^https?:\/\/\S+$/.test(url ?? '')) problems.push(`AI_LOCAL_ENDPOINTS entry for ${region} must be an http(s) base URL`);
  }
  if (e.AI_LOCAL_TIMEOUT_MS < 1000 || e.AI_LOCAL_TIMEOUT_MS > 600_000) problems.push('AI_LOCAL_TIMEOUT_MS must be 1000..600000');
  let aiAnthropicRegions: Region[] = [];
  try {
    aiAnthropicRegions = parseRegionList(e.AI_ANTHROPIC_REGIONS);
  } catch (err) {
    problems.push(`AI_ANTHROPIC_REGIONS: ${(err as Error).message}`);
  }
  if (e.AI_ANTHROPIC_TIMEOUT_MS < 1000 || e.AI_ANTHROPIC_TIMEOUT_MS > 600_000) problems.push('AI_ANTHROPIC_TIMEOUT_MS must be 1000..600000');
  if (e.AI_ANTHROPIC_MAX_RETRIES > 2)
    problems.push('AI_ANTHROPIC_MAX_RETRIES must be 0..2 (above 0 one attempt can outlast the section 11 latency target)');
  if (problems.length > 0) throw new ConfigError(`refusing to boot: ${problems.join('; ')}`);

  const suffixes = splitUrlList(e.ICE_OWN_HOST_SUFFIXES);
  const devStubRaw = (e.AGENT_DEV_STUB ?? './data/agent-dev-stub.bin').trim();
  return {
    nodeEnv: e.NODE_ENV,
    production,
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    host: e.HOST,
    nodeId: e.NODE_ID !== '' ? e.NODE_ID : `${hostname()}:${process.pid}`,
    apiOrigin,
    webOrigin,
    trustProxy: e.TRUST_PROXY,
    databaseUrl: e.DATABASE_URL,
    // Defaults to DATABASE_URL in dev only. A production api connects as DB_APP_ROLE, which cannot migrate by design,
    // and never receives the owner credential: empty here means the deployment's migrate step owns the schema.
    migrateDatabaseUrl: e.MIGRATE_DATABASE_URL !== '' ? e.MIGRATE_DATABASE_URL : production ? '' : e.DATABASE_URL,
    pgliteDir: abs(e.PGLITE_DIR),
    dbAppRole: e.DB_APP_ROLE,
    sessionCookieSecret: cookieSecret,
    tokenSigningKey: signingKey.toLowerCase(),
    tokenSigningKeysPrevious: splitUrlList(e.TOKEN_SIGNING_KEYS_PREVIOUS),
    defaultRegion,
    servedRegions,
    regionOrigins,
    turnSecret: e.TURN_SECRET,
    turnUrls,
    stunUrls: splitUrlList(e.STUN_URLS),
    iceOwnHostSuffixes: suffixes.length > 0 ? suffixes : [apiHost],
    turnTtlSeconds: e.TURN_TTL_SECONDS > 0 ? e.TURN_TTL_SECONDS : 3600,
    presenceDriver: e.PRESENCE_DRIVER,
    redisUrl: e.REDIS_URL,
    storageDriver: e.STORAGE_DRIVER,
    storageFsDir: abs(e.STORAGE_FS_DIR),
    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKey: e.S3_ACCESS_KEY,
      secretKey: e.S3_SECRET_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    },
    authProvider: 'local',
    logLevel: e.LOG_LEVEL,
    rateLimitDisabled: e.RATE_LIMIT_DISABLED,
    recordingDownloadOrigin: downloadOrigin,
    recordingQuota: {
      orgBytes: e.ORG_STORAGE_QUOTA_BYTES,
      orgOpenUploads: Math.max(1, e.ORG_MAX_OPEN_UPLOADS),
      userOpenUploads: Math.max(1, e.USER_MAX_OPEN_UPLOADS),
      uploadWindowSec: e.RECORDING_UPLOAD_WINDOW_SEC,
    },
    extension: {
      ids: extensionIds,
      webStoreUrl: e.EXTENSION_WEBSTORE_URL !== '' ? e.EXTENSION_WEBSTORE_URL : null,
      edgeAddonsUrl: e.EXTENSION_EDGE_URL !== '' ? e.EXTENSION_EDGE_URL : null,
      minVersion: e.EXTENSION_MIN_VERSION !== '' ? e.EXTENSION_MIN_VERSION : '0.2.0',
    },
    mirrorRelayBudgetBytes: e.MIRROR_RELAY_BUDGET_BYTES > 0 ? e.MIRROR_RELAY_BUDGET_BYTES : LIMITS.mirrorRelayBudgetBytes,
    signupPlanTier: e.SIGNUP_PLAN_TIER,
    recorderToken: e.RECORDER_TOKEN,
    agent: {
      distDir: abs(e.AGENT_DIST_DIR),
      minVersion: AGENT_VERSION_RE.test(e.AGENT_MIN_VERSION) ? e.AGENT_MIN_VERSION : '0.3.0',
      androidAppUrl: e.AGENT_ANDROID_APP_URL !== '' ? e.AGENT_ANDROID_APP_URL : null,
      devStub: production || devStubRaw === '' ? null : abs(devStubRaw),
    },
    fleet: {
      dataKey: Buffer.from(fleetKeyMatch![2]!, 'hex'),
      dataKeyId: fleetKeyMatch![1] ?? 'k1',
      previousKeys: previousFleetKeys,
      msiDistDir: abs(e.AGENT_MSI_DIST_DIR),
      wakeConfirmSec: e.WAKE_CONFIRM_SEC > 0 ? e.WAKE_CONFIRM_SEC : LIMITS.wakeConfirmSec,
      deviceHelloRate: e.DEVICE_HELLO_RATE > 0 ? e.DEVICE_HELLO_RATE : 500,
    },
    // Phase F section 3.1a: compose passes `${MAIL_FROM:-}`, and `str(def)` keeps '', so an empty value is the default.
    mail: { driver: e.MAIL_DRIVER, smtpUrl: e.SMTP_URL, from: e.MAIL_FROM !== '' ? e.MAIL_FROM : DEFAULT_MAIL_FROM, requireTls: smtpRequireTls },
    erasure: { devCoolingOffSec: erasureDevCoolingOffSec },
    backupRetentionDays,
    vault: { addr: e.VAULT_ADDR.replace(/\/+$/, ''), roleId: e.VAULT_ROLE_ID, secretId: e.VAULT_SECRET_ID },
    orgSecrets: {
      keyId: orgKeyMatch![1]!,
      key: Buffer.from(orgKeyMatch![2]!, 'hex'),
      previous: previousOrgKeys,
      fpKey: Buffer.from(fpKeyRaw, 'hex'),
    },
    egress: {
      allowHttp: e.EGRESS_ALLOW_HTTP,
      allowLoopback: e.EGRESS_ALLOW_LOOPBACK,
      privateAllow: egressAllow,
      metadataAddresses: splitUrlList(e.EGRESS_METADATA_ADDRESSES),
      devDnsServers: production ? [] : devDnsServers,
    },
    ai: {
      local: {
        endpoints: Object.fromEntries(Object.entries(aiLocalEndpoints).map(([r, u]) => [r, (u ?? '').replace(/\/+$/, '')])),
        model: e.AI_LOCAL_MODEL !== '' ? e.AI_LOCAL_MODEL : 'local',
        apiKey: e.AI_LOCAL_API_KEY,
        timeoutMs: e.AI_LOCAL_TIMEOUT_MS,
      },
      anthropic: {
        apiKey: e.AI_ANTHROPIC_API_KEY,
        regions: aiAnthropicRegions,
        model: e.AI_ANTHROPIC_MODEL !== '' ? e.AI_ANTHROPIC_MODEL : 'claude-opus-5-5',
        timeoutMs: e.AI_ANTHROPIC_TIMEOUT_MS,
        maxRetries: e.AI_ANTHROPIC_MAX_RETRIES,
      },
    },
    repoRoot,
    dataDir,
  };
}

/**
 * Y21: `chrome-extension://<id>` is an accepted Origin for an id in EXTENSION_IDS; with an empty list any extension
 * origin is accepted outside production (unpacked dev builds).
 */
export function isExtensionOrigin(config: Pick<Config, 'extension' | 'production'>, origin: string | undefined): boolean {
  if (typeof origin !== 'string') return false;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (!m) return false;
  if (config.extension.ids.length === 0) return !config.production;
  return config.extension.ids.includes(m[1]!);
}
