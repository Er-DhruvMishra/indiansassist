/**
 * Phase F stream mail (docs/specs/phase-f-contracts.md section 4.4): `GET /auth/options`, the password-reset request
 * and confirm routes, and `POST /users/:id/invite/resend`. Registered through `PHASE_F_ROUTE_PLUGINS` in app.ts; the
 * foundation lands it empty (it registers nothing) and the mail stream fills it without editing app.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function mailRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  void app;
  void ctx;
}
