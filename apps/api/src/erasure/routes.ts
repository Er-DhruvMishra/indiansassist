/**
 * Phase F stream erasure (docs/specs/phase-f-contracts.md section 5.6): the org erasure routes and the public
 * certificate and chain-digest routes. Registered through `PHASE_F_ROUTE_PLUGINS` in app.ts; the foundation lands it
 * empty (it registers nothing) and the erasure stream fills it without editing app.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function erasureRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  void app;
  void ctx;
}
