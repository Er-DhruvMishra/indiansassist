/**
 * pino options for Fastify (contracts section 6 logging contract): the binding redaction list, and a request
 * serializer that logs the path only (never the query string, so a token in `?t=` can never reach a log line).
 */
import { DrizzleQueryError } from 'drizzle-orm';
import type { FastifyServerOptions } from 'fastify';

const MAX_MESSAGE = 500;

function truncate(s: string, max = MAX_MESSAGE): string {
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

/** Stack frames only, re-headed with the sanitised message (the default header repeats the raw message). */
function frames(stack: string | undefined, header: string): string {
  if (!stack) return header;
  const lines = stack.split('\n');
  const first = lines.findIndex((l) => /^\s+at /.test(l));
  return [header, ...(first === -1 ? [] : lines.slice(first))].join('\n');
}

type ErrLike = Error & { code?: unknown; constraint?: unknown; statusCode?: unknown; cause?: unknown };

function isQueryError(e: object): boolean {
  return e instanceof DrizzleQueryError || ('query' in e && 'params' in e);
}

function causeOf(cause: unknown, depth: number): Record<string, unknown> | undefined {
  if (!cause || typeof cause !== 'object' || depth > 2) return undefined;
  const c = cause as ErrLike;
  if (isQueryError(c)) return { type: 'DrizzleQueryError', message: 'drizzle query failed', cause: causeOf(c.cause, depth + 1) };
  // Driver errors: code / constraint only plus a short message; `detail` (which echoes row values) is dropped.
  return {
    type: c.constructor?.name ?? 'Error',
    message: truncate(String(c.message ?? ''), 200),
    ...(c.code !== undefined ? { code: c.code } : {}),
    ...(c.constraint !== undefined ? { constraint: c.constraint } : {}),
  };
}

/**
 * pino `err` serializer (logging contract, section 6): a DrizzleQueryError carries the SQL and every bound parameter
 * in `message`, `query` and `params` (token signatures and nonces, password and cookie hashes, Desk labels), so it is
 * logged as `{ type, message: 'drizzle query failed', code, constraint, stack }` only. Every other error keeps type,
 * code, statusCode and a message truncated to 500 characters; no other own property is copied.
 */
export type SerializedError = { [key: string]: unknown; type: string; message: string; stack: string };

export function serializeError(err: unknown): SerializedError {
  if (!err || typeof err !== 'object') return { type: typeof err, message: truncate(String(err)), stack: '' };
  const e = err as ErrLike;
  if (isQueryError(e)) {
    const cause = e.cause as ErrLike | undefined;
    return {
      type: 'DrizzleQueryError',
      message: 'drizzle query failed',
      ...(cause?.code !== undefined ? { code: cause.code } : {}),
      ...(cause?.constraint !== undefined ? { constraint: cause.constraint } : {}),
      stack: frames(e.stack, 'DrizzleQueryError: drizzle query failed'),
    };
  }
  const type = e.constructor?.name ?? 'Error';
  const message = truncate(String(e.message ?? ''));
  const cause = causeOf(e.cause, 0);
  return {
    type,
    message,
    stack: frames(e.stack, `${type}: ${message}`),
    ...(e.code !== undefined ? { code: e.code } : {}),
    ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
    ...(cause ? { cause } : {}),
  };
}

export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.query',
  'req.url',
  '*.sdp',
  '*.text',
  '*.token',
  '*.compact',
  '*.resumeKey',
  '*.invite',
  '*.password',
  '*.sig',
  '*.credential',
];

export function pathOnly(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  if (level === 'silent') return false;
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      err: serializeError,
      req(req: { method?: string; url?: string; ip?: string; id?: string }) {
        return { method: req.method, path: pathOnly(req.url), remoteAddress: req.ip, reqId: req.id };
      },
    },
  };
}
