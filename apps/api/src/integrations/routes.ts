/**
 * Phase E stream tickets (docs/specs/phase-e-contracts.md section 4.7): the integration and ticket push routes.
 * Landed by the foundation as an empty plugin listed in `ENTERPRISE_ROUTE_PLUGINS` (app.ts); the tickets stream
 * fills it.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function integrationRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // Registers nothing until the tickets stream lands section 4.7.
}
