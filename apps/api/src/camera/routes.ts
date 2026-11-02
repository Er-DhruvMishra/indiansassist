/**
 * Phase F stream camera (docs/specs/phase-f-contracts.md section 6.7): the camera link and snapshot routes.
 * Registered through `PHASE_F_ROUTE_PLUGINS` in app.ts; the foundation lands it empty (it registers nothing) and the
 * camera stream fills it without editing app.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function cameraRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  void app;
  void ctx;
}
