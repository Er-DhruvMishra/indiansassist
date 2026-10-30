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
  AUTH_PROVIDER: z.enum(['local', 'oidc']).optional().default('local'),
  OIDC_ISSUER: str(''),
  OIDC_CLIENT_ID: str(''),
  OIDC_CLIENT_SECRET: str(''),
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
  authProvider: 'local' | 'oidc';
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
  repoRoot: string;
  /** Where dev secrets are persisted (`./data`). */
  dataDir: string;
};

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
    migrateDatabaseUrl: e.MIGRATE_DATABASE_URL !== '' ? e.MIGRATE_DATABASE_URL : e.DATABASE_URL,
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
    authProvider: e.AUTH_PROVIDER,
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
