/**
 * CORS for WEB_ORIGIN, the section 6.1 CSRF rule (header `X-Requested-With: IndiansAssist` on every non-GET/HEAD/
 * OPTIONS request under /api/v1, and `Origin === WEB_ORIGIN` when present) and the @fastify/rate-limit setup of
 * section 6.12 (IP keyed, 600 / minute default, tighter per-route limits declared by the routes).
 */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@indiansassist/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfOk(method: string, headers: Record<string, string | string[] | undefined>, webOrigin: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const xrw = headers[CSRF_HEADER.toLowerCase()];
  if (xrw !== CSRF_HEADER_VALUE) return false;
  const origin = headers['origin'];
  return origin === undefined || origin === webOrigin;
}

export async function registerSecurity(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(cors, {
    origin: ctx.config.webOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'],
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/v1/')) return;
    if (!csrfOk(req.method, req.headers, ctx.config.webOrigin))
      throw new HttpError('csrf_failed', 'missing or invalid CSRF header or origin');
  });

  if (!ctx.config.rateLimitDisabled) {
    await app.register(rateLimit, {
      global: true,
      max: 600,
      timeWindow: 60_000,
      onExceeded: () => ctx.metrics.rateLimited.inc(),
      errorResponseBuilder: (_req, c) =>
        new HttpError('rate_limited', 'too many requests', { retryAfterSec: Math.max(1, Math.ceil(c.ttl / 1000)) }),
    });
  }
}

/** Per-route config for the tighter IP limits of section 6.12 (ignored when rate limiting is disabled). */
export const limits = {
  auth: { rateLimit: { max: 10, timeWindow: 60_000 } },
  publicLookup: { rateLimit: { max: 30, timeWindow: 60_000 } },
};
