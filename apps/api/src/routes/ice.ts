/** `GET /api/v1/ice?sessionId=` (contracts section 6.11): TURN REST credentials, 10 / minute per user. */
import { iceQuerySchema, type IceResponse } from '@indiansassist/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail } from '../errors.js';
import { buildIceServers } from '../lib/ice.js';
import { TECH_ROLES } from '../lib/rbac.js';
import { parseOr400 } from '../lib/validate.js';
import { authenticate } from '../plugins/auth.js';
import { requireSessionAssist, scopedSession } from '../services/scope.js';

export async function iceRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/v1/ice', async (req): Promise<IceResponse> => {
    const p = await authenticate(ctx, req, TECH_ROLES);
    const q = parseOr400(iceQuerySchema, req.query);
    const lim = await ctx.limiter.hit(`ice:${p.user.id}`, 10, 60_000);
    if (!lim.allowed) {
      ctx.metrics.rateLimited.inc();
      fail('rate_limited', 'too many ICE requests', { retryAfterSec: lim.retryAfterSec });
    }
    if (q.sessionId) {
      const { session } = await scopedSession(ctx, p, q.sessionId);
      // Same rule as every "assist of the session" action: the user who accepted the knock (SEC-06).
      requireSessionAssist(p, session);
    }
    return buildIceServers(ctx.config, `user:${p.user.id}`);
  });
}
