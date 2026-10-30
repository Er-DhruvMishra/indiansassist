/**
 * Dev / production entry point (`tsx watch src/server.ts`, `node dist/server.js`): loads `.env` from the repo root,
 * opens the database (PGlite when DATABASE_URL is empty), applies migrations, builds the app, ends this node's
 * orphaned sessions (N3), starts the sweeper and serves HTTP + WS on PORT and Prometheus on METRICS_PORT.
 */
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { closeDb, createDb, migrate } from '@indiansassist/db';
import dotenv from 'dotenv';
import { buildApp } from './app.js';
import { findRepoRoot, loadConfig } from './config.js';
import { bootCleanup, Sweeper } from './sweeper.js';

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  dotenv.config({ path: resolve(repoRoot, '.env'), quiet: true });
  const config = loadConfig(process.env, { repoRoot });

  const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
  if (config.migrateDatabaseUrl !== '' && config.migrateDatabaseUrl !== config.databaseUrl) {
    const owner = await createDb({ databaseUrl: config.migrateDatabaseUrl });
    await migrate(owner, { appRole: config.dbAppRole || null });
    await closeDb(owner);
  } else {
    await migrate(db, { appRole: config.dbAppRole || null });
  }

  const { app, ctx } = await buildApp({ config, db });
  if (!ctx.presence.multiNode)
    app.log.info({ nodeId: config.nodeId }, 'presence driver is single-node: run one api replica (infra/HARDENING.md section 10)');
  const ended = await bootCleanup(ctx);
  if (ended > 0) app.log.warn({ ended, nodeId: config.nodeId }, 'ended sessions orphaned by a previous run of this node');
  const sweeper = new Sweeper(ctx);
  sweeper.start();
  const beat = (): Promise<void> =>
    ctx.presence.heartbeatNode(config.nodeId, 90).catch((err: unknown) => app.log.warn({ err }, 'presence heartbeat failed'));
  const heartbeat = setInterval(() => void beat(), 30_000);
  heartbeat.unref();
  await beat();

  await app.listen({ port: config.port, host: config.host });

  let metricsServer: Server | null = null;
  if (config.metricsPort > 0) {
    metricsServer = createServer((req, res) => {
      if ((req.url ?? '').split('?')[0] !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      ctx.metrics.registry
        .metrics()
        .then((body) => res.writeHead(200, { 'Content-Type': ctx.metrics.registry.contentType }).end(body))
        .catch(() => res.writeHead(500).end());
    });
    metricsServer.listen(config.metricsPort, config.host);
  }

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    sweeper.stop();
    clearInterval(heartbeat);
    metricsServer?.close();
    await app.close();
    await closeDb(db);
    process.exit(0);
  };
  // Phase C section 2.2: re-read AGENT_DIST_DIR/manifest.json (Windows has no SIGHUP; restart instead).
  if (process.platform !== 'win32')
    process.on('SIGHUP', () => {
      ctx.agentDist.load();
      app.log.info({ builds: ctx.agentDist.manifest().builds.length }, 'agent manifest reloaded');
    });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
