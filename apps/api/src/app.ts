/**
 * Fastify 5 app factory: `buildApp()` wires config, database, adapters, plugins (errors, cookie auth, CORS, CSRF,
 * rate limits, multipart), every REST route of contracts section 6 and the `/signal` WebSocket hub. Tests call it
 * with an in-memory PGlite database; src/server.ts adds the listeners, migrations, sweeper and metrics port.
 */
import { readFileSync } from 'node:fs';
import multipart from '@fastify/multipart';
import { LIMITS } from '@indiansassist/shared';
import type { Db } from '@indiansassist/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildAuthProvider } from './adapters/auth-provider.js';
import { RedisLimiter } from './adapters/limiter-redis.js';
import { buildPresence, type Presence } from './adapters/presence.js';
import { RedisPresence } from './adapters/presence-redis.js';
import type { ObjectStorage } from './adapters/storage.js';
import { FsObjectStorage } from './adapters/storage-fs.js';
import { S3ObjectStorage } from './adapters/storage-s3.js';
import type { Config } from './config.js';
import { DEFAULT_TIMING, type AppContext, type Timing } from './context.js';
import { derivePresignKey } from './lib/crypto.js';
import { loadKeySet } from './lib/keys.js';
import { loggerOptions } from './lib/logger.js';
import { createMetrics, type Metrics } from './lib/metrics.js';
import { MemoryLimiter, ShortCodeBudget, type Limiter } from './limiter.js';
import { registerAuth } from './plugins/auth.js';
import { registerErrorHandlers } from './plugins/errors.js';
import { registerSecurity } from './plugins/security.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { iceRoutes } from './routes/ice.js';
import { internalRecordingRoutes } from './routes/internal-recordings.js';
import { orgRoutes } from './routes/orgs.js';
import { recordingRoutes } from './routes/recordings.js';
import { sessionEventRoutes } from './routes/session-events.js';
import { sessionRoutes } from './routes/sessions.js';
import { policyRoutes } from './routes/policies.js';
import { tokenRoutes } from './routes/tokens.js';
import { userRoutes } from './routes/users.js';
import { SignalHub } from './signal/hub.js';
import { AgentDist } from './services/agent-dist.js';
import { downloadRoutes } from './routes/download.js';
import { playbookRoutes } from './routes/playbooks.js';
import { deviceRoutes } from './fleet/routes-devices.js';
import { fleetAdminRoutes } from './fleet/routes-admin.js';
import { buildMailer } from './mail/mailer.js';

export type BuildAppOptions = {
  config: Config;
  db: Db;
  storage?: ObjectStorage;
  presence?: Presence;
  timing?: Partial<Timing>;
  metrics?: Metrics;
  /** pino level; 'silent' disables logging (tests). Defaults to config.logLevel. */
  logLevel?: string;
};

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildStorage(config: Config, presignKey: Buffer): ObjectStorage {
  return config.storageDriver === 's3'
    ? new S3ObjectStorage(config.s3)
    : new FsObjectStorage({ root: config.storageFsDir, fileOrigin: config.recordingDownloadOrigin, presignKey });
}

/** The limiter follows the presence driver: cluster-wide on Redis, per process on memory (section 6.12). */
function buildLimiter(presence: Presence, disabled: boolean): Limiter {
  return presence instanceof RedisPresence ? new RedisLimiter(presence.client, disabled) : new MemoryLimiter(disabled);
}

export async function buildApp(opts: BuildAppOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const { config, db } = opts;
  const app = Fastify({
    logger: loggerOptions(opts.logLevel ?? config.logLevel),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  const presignKey = derivePresignKey(config.sessionCookieSecret);
  const presence =
    opts.presence ??
    buildPresence(config.presenceDriver, config.nodeId, {
      redisUrl: config.redisUrl,
      onError: (err, where) => app.log.warn({ err, where }, 'presence driver error'),
    });
  const ctx: AppContext = {
    config,
    db,
    storage: opts.storage ?? buildStorage(config, presignKey),
    presence,
    limiter: buildLimiter(presence, config.rateLimitDisabled),
    shortCodes: new ShortCodeBudget(() => app.log.warn({ alert: true }, 'short_code_budget_exhausted')),
    keys: await loadKeySet(config.tokenSigningKey, config.tokenSigningKeysPrevious),
    metrics: opts.metrics ?? createMetrics(),
    presignKey,
    authProvider: buildAuthProvider(config.authProvider, db),
    log: app.log,
    timing: { ...DEFAULT_TIMING, ...opts.timing },
    version: packageVersion(),
    agentDist: new AgentDist(config),
    hub: null as unknown as SignalHub,
    mailer: buildMailer(config, app.log),
  };
  ctx.agentDist.load();
  if (ctx.agentDist.lastError) app.log.info({ reason: ctx.agentDist.lastError }, 'no agent builds served by this node');
  ctx.hub = new SignalHub(ctx);

  registerErrorHandlers(app);
  await registerAuth(app, ctx);
  await registerSecurity(app, ctx);
  await app.register(multipart, {
    limits: { fileSize: LIMITS.recordingSingleMaxBytes, files: 1, fields: 5, parts: 10 },
  });

  await healthRoutes(app, ctx);
  await authRoutes(app, ctx);
  await orgRoutes(app, ctx);
  await userRoutes(app, ctx);
  await tokenRoutes(app, ctx);
  await sessionRoutes(app, ctx);
  await sessionEventRoutes(app, ctx);
  await policyRoutes(app, ctx);
  await auditRoutes(app, ctx);
  await recordingRoutes(app, ctx);
  await iceRoutes(app, ctx);
  await internalRecordingRoutes(app, ctx);
  await downloadRoutes(app, ctx);
  await playbookRoutes(app, ctx);
  // Phase D (docs/specs/phase-d-contracts.md section 7.2)
  await deviceRoutes(app, ctx);
  await fleetAdminRoutes(app, ctx);

  ctx.hub.attach(app);
  await ctx.hub.start();
  app.addHook('onClose', async () => {
    await ctx.hub.close();
    await ctx.presence.close();
  });
  return { app, ctx };
}
