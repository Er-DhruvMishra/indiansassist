/** Error handler and 404 handler producing the section 6.2 envelope `{ error: { code, message, details? } }`. */
import { apiError, isApiErrorCode, type ApiErrorCode } from '@indiansassist/shared';
import { DbError, InvalidCursorError, NotFoundError, SessionAlreadyEndedError } from '@indiansassist/db';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from '../errors.js';
import { CREDENTIAL_ROUTE_RE, pathOnly, serializeErrorWithoutMessages } from '../lib/logger.js';

type Mapped = { status: number; code: ApiErrorCode; message: string; details?: Record<string, unknown> };

function statusFor(code: ApiErrorCode): number {
  return new HttpError(code, '').statusCode;
}

export function mapError(err: unknown): Mapped {
  if (err instanceof HttpError) {
    return { status: err.statusCode, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  if (err instanceof ZodError)
    return { status: 400, code: 'validation_failed', message: 'invalid request', details: { issues: err.issues } };
  if (err instanceof SessionAlreadyEndedError) return { status: 409, code: 'already_ended', message: err.message };
  if (err instanceof InvalidCursorError) return { status: 400, code: 'validation_failed', message: err.message };
  if (err instanceof NotFoundError) return { status: 404, code: 'not_found', message: 'not found' };
  if (err instanceof DbError && isApiErrorCode(err.code))
    return { status: statusFor(err.code), code: err.code, message: err.message };
  const e = err as Partial<FastifyError> & { code?: string; statusCode?: number };
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || code === 'FST_REQ_FILE_TOO_LARGE' || e.statusCode === 413)
    return { status: 413, code: 'payload_too_large', message: 'payload too large' };
  if (code.startsWith('FST_ERR_CTP') || code === 'FST_ERR_VALIDATION' || code.startsWith('FST_INVALID_MULTIPART'))
    return { status: 400, code: 'validation_failed', message: e.message ?? 'invalid request body' };
  if (code === 'FST_PARTS_LIMIT' || code === 'FST_FILES_LIMIT' || code === 'FST_FIELDS_LIMIT')
    return { status: 413, code: 'payload_too_large', message: e.message ?? 'too many parts' };
  if (e.statusCode === 404) return { status: 404, code: 'not_found', message: 'not found' };
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500)
    return { status: 400, code: 'validation_failed', message: e.message ?? 'bad request' };
  return { status: 500, code: 'internal', message: 'internal error' };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const m = mapError(err);
    if (m.status >= 500) {
      // Auth and token routes: no message of any kind, it might quote the credential-bearing body (SEC-07).
      if (CREDENTIAL_ROUTE_RE.test(pathOnly(req.url))) req.log.error({ error: serializeErrorWithoutMessages(err) }, 'request failed');
      else req.log.error({ err }, 'request failed');
    }
    else req.log.info({ code: m.code, status: m.status }, 'request rejected');
    if (m.code === 'rate_limited' && m.details?.['retryAfterSec'] !== undefined)
      void reply.header('Retry-After', String(m.details['retryAfterSec']));
    return reply.status(m.status).send(apiError(m.code, m.message, m.details));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(apiError('not_found', 'route not found')));
}
