/**
 * Phase E stream residency (docs/specs/phase-e-contracts.md section 6.4): the residency routes (the A
 * `GET /orgs/current/residency` moves here from routes/orgs.ts with `services/residency.ts`, plus
 * `GET .../residency/signed.json`). Landed by the foundation as an empty plugin listed in `ENTERPRISE_ROUTE_PLUGINS`
 * (app.ts); the residency stream fills it.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function residencyRoutes(_app: FastifyInstance, _ctx: AppContext): Promise<void> {
  // Registers nothing until the residency stream lands section 6.4.
}
