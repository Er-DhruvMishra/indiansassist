/**
 * Phase E stream sso (docs/specs/phase-e-contracts.md section 3.9): the SSO routes. Landed by the foundation as an
 * empty plugin listed in `ENTERPRISE_ROUTE_PLUGINS` (app.ts); the sso stream fills it.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function ssoRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // Registers nothing until the sso stream lands section 3.9.
}
