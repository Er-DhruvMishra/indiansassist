/**
 * Phase F stream mail (docs/specs/phase-f-contracts.md section 4.4): `GET /auth/options` and the password-reset
 * request and confirm routes. Registered through `PHASE_F_ROUTE_PLUGINS` in app.ts. The invite mail and
 * `POST /users/:id/invite/resend` live in `routes/users.ts` beside the invite (section 1.4), on top of `invite.ts`.
 *
 * Rate limits (section 2.3, per IP): request 5 / minute, confirm 10 / minute. The per-user hourly mail cap of the
 * request is the presence counter of `reset.ts` and holds even with RATE_LIMIT_DISABLED (it is an abuse brake).
 */
import { passwordResetConfirmSchema, passwordResetRequestSchema, type AuthOptions } from '@indiansassist/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { parseOr400 } from '../lib/validate.js';
import { confirmReset, handleResetRequest } from './reset.js';
import { afterReply, mailAvailable, settleMailWork } from './send.js';

const RESET_REQUEST_LIMIT = { rateLimit: { max: 5, timeWindow: 60_000 } };
const RESET_CONFIRM_LIMIT = { rateLimit: { max: 10, timeWindow: 60_000 } };

export async function mailRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // Work started after a reply finishes before the database closes.
  app.addHook('onClose', async () => {
    await settleMailWork(ctx);
  });

  // Rule 4.1c: from config only, never per account.
  app.get('/api/v1/auth/options', async (): Promise<AuthOptions> => {
    const on = mailAvailable(ctx);
    return { passwordReset: on, inviteMail: on };
  });

  // Rule 4.3a: always `202 {}`; the lookup, the token and the mail happen after the reply.
  app.post('/api/v1/auth/password-reset/request', { config: RESET_REQUEST_LIMIT }, async (req, reply) => {
    const body = parseOr400(passwordResetRequestSchema, req.body);
    afterReply(ctx, () => handleResetRequest(ctx, body.email));
    return reply.status(202).send({});
  });

  app.post('/api/v1/auth/password-reset/confirm', { config: RESET_CONFIRM_LIMIT }, async (req, reply) => {
    const body = parseOr400(passwordResetConfirmSchema, req.body);
    await confirmReset(ctx, body.token, body.newPassword);
    return reply.status(204).send();
  });
}
