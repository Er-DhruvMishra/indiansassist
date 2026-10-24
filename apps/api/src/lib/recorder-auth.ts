/**
 * Service-token auth of the Phase A.2 server recorder (docs/specs/phase-a2-recorder.md section 2 P2): constant-time
 * compare against `RECORDER_TOKEN`; an empty api token means the recorder is disabled and nothing matches.
 */
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { fail } from '../errors.js';
import { safeEqual } from './crypto.js';

export function recorderEnabled(config: Pick<Config, 'recorderToken'>): boolean {
  return config.recorderToken !== '';
}

/** True when `presented` equals the configured token (timingSafeEqual; a length mismatch is false). */
export function recorderTokenOk(config: Pick<Config, 'recorderToken'>, presented: string | null | undefined): boolean {
  return recorderEnabled(config) && safeEqual(presented, config.recorderToken);
}

/** The bearer credential of `Authorization: Bearer <token>`, or null. */
export function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

/**
 * Internal routes: `404 not_found` when the recorder is disabled (the route does not exist), `401 unauthenticated`
 * on a missing or wrong token.
 */
export function requireRecorder(config: Pick<Config, 'recorderToken'>, req: FastifyRequest): void {
  if (!recorderEnabled(config)) fail('not_found', 'not found');
  if (!recorderTokenOk(config, bearerOf(req))) fail('unauthenticated', 'recorder token required');
}
