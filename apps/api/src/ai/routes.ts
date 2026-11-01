/**
 * Phase E stream ai (docs/specs/phase-e-contracts.md section 5.9): the AI policy, capabilities and summary routes.
 * Landed by the foundation as an empty plugin listed in `ENTERPRISE_ROUTE_PLUGINS` (app.ts); the ai stream fills it
 * (and registers its rule 5.8a entry in `onSessionEnded`, services/session-end.ts, from its own module).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function aiRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // Registers nothing until the ai stream lands section 5.9.
}
