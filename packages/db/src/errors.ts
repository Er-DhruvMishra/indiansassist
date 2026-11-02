/** Typed errors raised by the repository layer; the API maps them to the section 6.2 envelope. */
import type { SessionState } from '@indiansassist/shared';

export class DbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** org.data_region is immutable (rule R1); raised before any SQL runs. */
export class RegionImmutableError extends DbError {
  constructor() {
    super('region_immutable', 'data_region is immutable');
  }
}

/** An audit entry's region differs from org.data_region (section 4.2 audit_entry.region). */
export class AuditRegionMismatchError extends DbError {
  constructor(expected: string, got: string) {
    super('region_mismatch', `audit region ${got} does not equal org.data_region ${expected}`);
  }
}

export class NotFoundError extends DbError {
  constructor(what: string, id: string) {
    super('not_found', `${what} ${id} not found`);
  }
}

/** A session state change the section 7.4 machine does not allow (or that lost a race). */
export class InvalidSessionTransitionError extends DbError {
  readonly from: SessionState | null;
  readonly to: SessionState;
  constructor(from: SessionState | null, to: SessionState, detail?: string) {
    super(
      'invalid_transition',
      `session transition ${from ?? '?'} -> ${to} is not allowed${detail ? `: ${detail}` : ''}`,
    );
    this.from = from;
    this.to = to;
  }
}

/** The session is already `ended` (maps to `409 already_ended`). */
export class SessionAlreadyEndedError extends InvalidSessionTransitionError {
  constructor(to: SessionState) {
    super('ended', to, 'session already ended');
    (this as { code: string }).code = 'already_ended';
  }
}

export class ShortCodeExhaustedError extends DbError {
  constructor(attempts: number) {
    super('short_code_exhausted', `no free short code after ${attempts} attempts`);
  }
}

const UNIQUE_VIOLATION = '23505';

/** True for a Postgres unique violation from either driver (drizzle may wrap the driver error in `cause`). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    const rec = e as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === UNIQUE_VIOLATION) {
      if (!constraint) return true;
      if (rec.constraint === constraint) return true;
      return typeof rec.message === 'string' && rec.message.includes(constraint);
    }
    e = rec.cause;
  }
  return false;
}

/**
 * Phase F section 5.3 step 6: the org's erasure destroyed its audit pepper. `insertAuditEntry` refuses it (no entry
 * can follow `org.erased`), and the api's `piiHash` refuses it (a null pepper would yield an unpeppered hash).
 */
export class OrgErasedError extends DbError {
  readonly orgId: string;
  constructor(orgId: string) {
    super('org_erased', `org ${orgId} was erased`);
    this.orgId = orgId;
  }
}

/** Phase E section 13.2a: a named summary version that is not `ready` (maps to `409 summary_not_ready`). */
export class SummaryNotReadyError extends DbError {
  readonly sessionId: string;
  readonly version: number;
  readonly state: string;
  constructor(sessionId: string, version: number, state: string) {
    super('summary_not_ready', `summary version ${version} of session ${sessionId} is ${state}, not ready`);
    this.sessionId = sessionId;
    this.version = version;
    this.state = state;
  }
}
