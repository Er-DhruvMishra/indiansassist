/** `GET /api/v1/health` and `GET /.well-known/indiansassist.json` (contracts sections 3.4, 6.4). */
import type { FastifyInstance } from 'fastify';
import { publicKeyToBase64url } from '@indiansassist/shared';
import type { AppContext } from '../context.js';

export function wsOrigin(httpOrigin: string): string {
  return httpOrigin.replace(/^http/, 'ws');
}

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/health', async () => ({
    ok: true as const,
    region: ctx.config.defaultRegion,
    servedRegions: ctx.config.servedRegions,
    nodeId: ctx.config.nodeId,
    version: ctx.version,
    time: new Date().toISOString(),
  }));

  app.get('/.well-known/indiansassist.json', async (_req, reply) => {
    void reply.header('Cache-Control', 'public, max-age=300');
    return {
      v: 1,
      region: ctx.config.defaultRegion,
      keys: ctx.keys.all.map((k) => ({
        kid: k.kid,
        alg: 'Ed25519',
        pub: publicKeyToBase64url(k.pub),
        createdAt: ctx.keys.createdAt.toISOString(),
      })),
      api: `${ctx.config.apiOrigin}/api/v1`,
      signal: `${wsOrigin(ctx.config.apiOrigin)}/signal`,
      join: `${ctx.config.webOrigin}/join`,
    };
  });
}
