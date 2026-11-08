/**
 * CORS for WEB_ORIGIN, the section 6.1 CSRF rule (header `X-Requested-With: IndiansAssist` on every non-GET/HEAD/
 * OPTIONS request under /api/v1, and `Origin === WEB_ORIGIN` when present) and the @fastify/rate-limit setup of
 * section 6.12 (IP keyed, 600 / minute default, tighter per-route limits declared by the routes). With the redis
 * presence driver the counters live in Redis (`ia:rl-http:`), so the limits hold across api replicas.
 */
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@indiansassist/shared';
import type { FastifyInstance } from 'fastify';
import { RedisPresence } from '../adapters/presence-redis.js';
import { isExtensionOrigin } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Routes on which a listed extension origin passes the CSRF origin rule (Phase B Y21); the header stays required. */
export const EXTENSION_ORIGIN_ROUTES = new Set(['/api/v1/tokens/public-lookup']);

/**
 * Phase E section 3.5 S3: the SAML ACS is exempt from the CSRF rule. The IdP's browser POST carries no
 * `X-Requested-With` and a foreign `Origin`; its authenticity is the signed assertion, the single-use flow record bound
 * to the route's org and the per-flow binding cookie. This pattern is the only entry.
 */
export const CSRF_EXEMPT_ROUTES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/api\/v1\/auth\/sso\/saml\/[0-9a-fA-F-]{36}\/acs$/ },
];

export function csrfExempt(method: string, path: string): boolean {
  return CSRF_EXEMPT_ROUTES.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}

export function csrfOk(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  webOrigin: string,
  extensionOriginOk: (origin: string) => boolean = () => false,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const xrw = headers[CSRF_HEADER.toLowerCase()];
  if (xrw !== CSRF_HEADER_VALUE) return false;
  const origin = headers['origin'];
  return origin === undefined || origin === webOrigin || (typeof origin === 'string' && extensionOriginOk(origin));
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
    const path = req.url.split('?')[0] ?? '';
    if (csrfExempt(req.method, path)) return;
    const extOk = EXTENSION_ORIGIN_ROUTES.has(path) ? (o: string) => isExtensionOrigin(ctx.config, o) : undefined;
    if (!csrfOk(req.method, req.headers, ctx.config.webOrigin, extOk))
      throw new HttpError('csrf_failed', 'missing or invalid CSRF header or origin');
  });

  if (!ctx.config.rateLimitDisabled) {
    const redis = ctx.presence instanceof RedisPresence ? ctx.presence.native : null;
    await app.register(rateLimit, {
      ...(redis ? { redis, nameSpace: 'ia:rl-http:' } : {}),
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
  // The public downloads page: one list, and a few Range requests per file, per IP (a NAT shares them).
  publicDownloadsList: { rateLimit: { max: 120, timeWindow: 60_000 } },
  publicDownloadsFile: { rateLimit: { max: 60, timeWindow: 60_000 } },
  // Phase E section 2.5 (per IP; NAT-friendly).
  ssoDiscover: { rateLimit: { max: 120, timeWindow: 60_000 } },
  ssoBegin: { rateLimit: { max: 120, timeWindow: 60_000 } },
  ssoReturn: { rateLimit: { max: 300, timeWindow: 60_000 } },
};
