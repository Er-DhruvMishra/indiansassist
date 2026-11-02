/** Error codes (contracts sections 6.2 and 7.3). */

/** REST error code -> HTTP status (section 6.2). */
export const API_ERROR_STATUS = {
  validation_failed: 400,
  token_malformed: 400,
  token_bad_signature: 400,
  invalid_token_type: 400,
  // Phase D sections 3.2, 3.8
  invalid_enroll_config: 400,
  invalid_group: 400,
  device_bad_signature: 400,
  tier_not_licensed: 400,
  upload_incomplete: 400,
  last_org_admin: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  invite_invalid: 401,
  reauth_required: 401,
  /** Phase D section 7.2: a bad deregister signature, stale `ts` or reused nonce. */
  device_unauthenticated: 401,
  forbidden: 403,
  /** Phase C section 8.2: a `requiresElevation` playbook on a session below `elevated`. */
  elevation_required: 403,
  csrf_failed: 403,
  /** Phase D sections 3.4, 4.2. */
  device_disabled: 403,
  capability_mismatch: 403,
  not_found: 404,
  token_not_found: 404,
  email_taken: 409,
  slug_taken: 409,
  token_busy: 409,
  already_ended: 409,
  recording_exists: 409,
  // Phase C sections 8.2, 2.2
  bad_state: 409,
  playbook_name_taken: 409,
  playbook_disabled: 409,
  playbook_changed: 409,
  // Phase D sections 3.5, 6.2, 8.4, 9.9
  device_offline: 409,
  device_busy: 409,
  nobody_present: 409,
  unattended_denied: 409,
  approval_required: 409,
  outside_policy_window: 409,
  recorder_required: 409,
  prelogin_not_permitted: 409,
  amt_unavailable: 409,
  policy_forbidden: 409,
  token_gone: 410,
  link_expired: 410,
  /** Phase B Y26: the recording's object was deleted (manual or retention). */
  recording_deleted: 410,
  /** Phase C section 2.2: a one_time token whose session already reached `active`. */
  token_used: 410,
  payload_too_large: 413,
  region_mismatch: 421,
  rate_limited: 429,
  internal: 500,
  /** Phase C section 2.2: no agent build for the platform / arch on this node. */
  download_unavailable: 503,
  /** Phase D rule 9.8: the credential vault is not configured or unreachable. */
  vault_unavailable: 503,
  // ---------- Phase E (docs/specs/phase-e-contracts.md section 2.6) ----------
  /** Password login, accept-invite or password change of a non-break-glass user of an SSO-required org. */
  sso_required: 403,
  /** `details.missing` (section 3.7a). */
  sso_not_ready: 409,
  sso_required_on: 409,
  last_break_glass: 409,
  break_glass_invalid_user: 400,
  /** `details.cause`. */
  sso_discovery_failed: 400,
  sso_cert_invalid: 400,
  domain_invalid: 400,
  domain_not_allowed: 400,
  domain_taken: 409,
  domain_exists: 409,
  push_id_conflict: 409,
  domain_limit: 409,
  /** `details.found` (at most 5 values, each cut to 100 chars). */
  domain_unverified: 409,
  /** `details.cause` (section 2.2 G1/G2 at save time). */
  egress_refused: 400,
  integration_not_configured: 409,
  integration_disabled: 409,
  session_not_ended: 409,
  summary_not_ready: 409,
  summary_running: 409,
  summary_conflict: 409,
  retry_limit: 409,
  ai_provider_unavailable: 409,
  ai_ack_required: 400,
  ai_disabled: 409,
  ai_transcript_disabled: 409,
  transcript_notice_missing: 409,
  // ---------- Phase F (docs/specs/phase-f-contracts.md section 2.4) ----------
  /** One code for an unknown, used, expired or superseded reset token (section 4.3). */
  reset_invalid: 400,
  /** Another erasure of the org is open; or the admin set is frozen while one is open (section 5.2e). */
  erasure_exists: 409,
  /** No eligible approver, or an ineligible approval (section 5.2b); `details.soloAvailable` (5.2f). */
  erasure_second_admin: 409,
  erasure_confirm_mismatch: 400,
  erasure_confirm_invalid: 400,
  camera_unrecordable: 409,
  erasure_not_cancellable: 409,
  /** Every authenticated request, login and socket hello of an org whose erasure is `executing` (section 5.3 step 1). */
  org_erasing: 409,
  camera_busy: 409,
  camera_unsupported: 409,
  /** `POST /devices/:id/sessions` to a `linux` device whose interactive state is `none` (section 8.4f). */
  prelogin_unsupported: 409,
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
  // Phase D sections 3.4, 3.8, 4.2: `/signal/device` auth and the worker credential.
  'unauthenticated',
  'device_unauthenticated',
  'device_disabled',
  'device_bad_signature',
  'capability_mismatch',
  // Phase F section 6.4: a bad, spent or expired camera code or resume key; a second camera for a session.
  'camera_link_invalid',
  'camera_busy',
  // Phase F section 2.4: the hello of an org whose erasure is executing (on /signal and /signal/device).
  'org_erasing',
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
