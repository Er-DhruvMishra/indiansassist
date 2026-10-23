/** REST error type mapped to the section 6.2 envelope by the error handler (plugins/errors.ts). */
import { httpStatusOf, type ApiErrorCode } from '@indiansassist/shared';

export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = httpStatusOf(code);
    this.details = details;
  }
}

export function fail(code: ApiErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new HttpError(code, message, details);
}
