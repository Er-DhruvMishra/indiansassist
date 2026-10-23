/** Error codes (contracts sections 6.2 and 7.3). */

/** REST error code -> HTTP status (section 6.2). */
export const API_ERROR_STATUS = {
  validation_failed: 400,
  token_malformed: 400,
  token_bad_signature: 400,
  invalid_token_type: 400,
  tier_not_licensed: 400,
  upload_incomplete: 400,
  last_org_admin: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  invite_invalid: 401,
  reauth_required: 401,
  forbidden: 403,
  csrf_failed: 403,
  not_found: 404,
  token_not_found: 404,
  email_taken: 409,
  slug_taken: 409,
  token_busy: 409,
  already_ended: 409,
  recording_exists: 409,
  token_gone: 410,
  link_expired: 410,
  payload_too_large: 413,
  region_mismatch: 421,
  rate_limited: 429,
  internal: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as ApiErrorCode[];

/** Error codes carried by the WS `error` message (section 7.3). */
export const SIGNAL_ERROR_CODES = [
  'unknown_type',
  'bad_payload',
  'not_authenticated',
  'forbidden',
  'token_malformed',
  'token_bad_signature',
  'token_not_found',
  'token_gone',
  'region_mismatch',
  'token_busy',
  'join_unsupported',
  'session_not_found',
  'bad_state',
  'consent_required',
  'relay_closed',
  'payload_too_large',
  'rate_limited',
] as const;
export type SignalErrorCode = (typeof SIGNAL_ERROR_CODES)[number];

/** Failure codes of token verification (section 3.5). */
export const TOKEN_ERROR_CODES = [
  'token_malformed',
  'token_bad_signature',
  'region_mismatch',
  'token_gone',
  'token_not_found',
] as const;
export type TokenErrorCode = (typeof TOKEN_ERROR_CODES)[number];

/** The `error` member of the REST error envelope. */
export type ApiError = {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

/** `{ error: ApiError }`, the body of every non-2xx REST response. */
export type ApiErrorEnvelope = { error: ApiError };

export function isApiErrorCode(x: unknown): x is ApiErrorCode {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(API_ERROR_STATUS, x);
}

export function httpStatusOf(code: ApiErrorCode): number {
  return API_ERROR_STATUS[code];
}

/** Builds a REST error envelope. */
export function apiError(code: ApiErrorCode, message: string, details?: Record<string, unknown>): ApiErrorEnvelope {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } };
}
