/**
 * `signal.forbidden` budget (contracts sections 5.3, 6.12, 7.2; SEC-05). The state is kept per principal on the hub,
 * not on the socket, so reconnecting does not reset it: an authenticated Assist is keyed by its user id, a Desk by its
 * token id. Per principal and rolling minute:
 * - one chain entry per (principal, sessionId) per FORBIDDEN_COALESCE_MS;
 * - at most FORBIDDEN_ENTRIES_PER_MIN entries in all, whatever the session ids (random ids cannot multiply rows);
 * - every refused frame that is not written is counted and reported as `suppressed` on the principal's next entry;
 * - more than FORBIDDEN_CLOSE_AFTER refused frames closes the socket `4403`, and while the principal stays above it
 *   (the cooldown) every further forbidden frame closes its socket at once and `assist.hello` is refused.
 */

export const FORBIDDEN_COALESCE_MS = 60_000;
/** Chain entries per principal per minute, across all session ids. */
export const FORBIDDEN_ENTRIES_PER_MIN = 10;
/** More refused frames than this per principal within a minute close the socket `4403`. */
export const FORBIDDEN_CLOSE_AFTER = 20;
const WINDOW_MS = 60_000;
/** Session ids remembered per principal for coalescing. */
const MAX_SESSION_KEYS = 64;
/** Principals tracked at most (oldest idle ones are dropped first). */
const MAX_PRINCIPALS = 10_000;

type State = {
  /** Refused frames in the last minute. */
  times: number[];
  /** Entries written in the last minute. */
  written: number[];
  /** sessionId -> when its last entry was written. */
  sessions: Map<string, number>;
  /** Refused frames not written since the previous entry. */
  suppressed: number;
  lastSeen: number;
};

export type ForbiddenDecision = {
  /** Write a chain entry (Assist) / a warn log line (Desk) for this frame. */
  write: boolean;
  /** `suppressed` to put on the entry when `write`. */
  suppressed: number;
  /** Close the sending socket `4403`. */
  flood: boolean;
  /** Refused frames of the principal in the last minute (this one included). */
  recent: number;
};

export class ForbiddenGuard {
  private readonly byPrincipal = new Map<string, State>();

  record(principal: string, sessionId: string | null, now = Date.now()): ForbiddenDecision {
    let st = this.byPrincipal.get(principal);
    if (st) this.byPrincipal.delete(principal); // re-inserted below: Map order is least recently seen first
    else st = { times: [], written: [], sessions: new Map(), suppressed: 0, lastSeen: now };
    this.byPrincipal.set(principal, st);
    if (this.byPrincipal.size > MAX_PRINCIPALS) {
      const oldest = this.byPrincipal.keys().next().value;
      if (oldest !== undefined) this.byPrincipal.delete(oldest);
    }
    st.lastSeen = now;
    st.times = st.times.filter((x) => x > now - WINDOW_MS);
    st.times.push(now);
    st.written = st.written.filter((x) => x > now - WINDOW_MS);
    const key = sessionId ?? '-';
    const last = st.sessions.get(key);
    const flood = st.times.length > FORBIDDEN_CLOSE_AFTER;
    const coalesced = last !== undefined && now - last < FORBIDDEN_COALESCE_MS;
    const overBudget = st.written.length >= FORBIDDEN_ENTRIES_PER_MIN;
    if (flood || coalesced || overBudget) {
      st.suppressed += 1;
      return { write: false, suppressed: 0, flood, recent: st.times.length };
    }
    const suppressed = st.suppressed;
    st.suppressed = 0;
    st.written.push(now);
    st.sessions.delete(key);
    st.sessions.set(key, now);
    if (st.sessions.size > MAX_SESSION_KEYS) {
      const oldest = st.sessions.keys().next().value;
      if (oldest !== undefined) st.sessions.delete(oldest);
    }
    return { write: true, suppressed, flood: false, recent: st.times.length };
  }

  /** True while the principal is above the flood limit (its sockets are closed, `assist.hello` refused). */
  flooding(principal: string, now = Date.now()): boolean {
    const st = this.byPrincipal.get(principal);
    if (!st) return false;
    return st.times.filter((x) => x > now - WINDOW_MS).length > FORBIDDEN_CLOSE_AFTER;
  }

  /** Seconds until the principal drops back to the limit. */
  retryAfterSec(principal: string, now = Date.now()): number {
    const st = this.byPrincipal.get(principal);
    if (!st) return 0;
    const recent = st.times.filter((x) => x > now - WINDOW_MS);
    const excess = recent.length - FORBIDDEN_CLOSE_AFTER;
    if (excess <= 0) return 0;
    return Math.max(1, Math.ceil((recent[excess - 1]! + WINDOW_MS - now) / 1000));
  }

  /** Drops principals idle for 10 minutes (their unreported `suppressed` count goes with them). */
  prune(now = Date.now()): void {
    for (const [k, st] of this.byPrincipal) {
      if (st.lastSeen > now - 10 * WINDOW_MS) break; // least recently seen first
      this.byPrincipal.delete(k);
    }
  }
}

/** The guard key of a socket: `user:<id>` for an authenticated Assist, `desk:<tokenId>` for a Desk. */
export function forbiddenKey(conn: {
  id: string;
  side: 'assist' | 'desk' | null;
  principal: { user: { id: string } } | null;
  desk: { tokenId: string } | null;
}): string {
  if (conn.side === 'assist' && conn.principal) return `user:${conn.principal.user.id}`;
  if (conn.desk) return `desk:${conn.desk.tokenId}`;
  return `conn:${conn.id}`;
}
