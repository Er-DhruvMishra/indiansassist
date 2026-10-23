/** One `/signal` socket and the per-session live registry entry (contracts section 7.2). */
import { randomUUID } from 'node:crypto';
import type { SessionPath, SessionState, SignalErrorCode } from '@indiansassist/shared';
import WebSocket from 'ws';
import type { Principal } from '../plugins/auth.js';
import { TokenBucket } from '../limiter.js';

export type DeskInfo = {
  tokenId: string;
  orgId: string;
  via: 'compact' | 'short_code';
  /** `desk.hello.deskLabel`, the fallback for `desk.knock.deskLabel`. */
  helloLabel: string | null;
  /** The session this socket is the Desk participant of (null while waiting). */
  sessionId: string | null;
  /** A knock is held for a technician (section 7.5). */
  held: boolean;
  heldLabel: string | null;
  /** `token.expires_at` (ms) seen at hello; a waiting / held Desk past it is told `token_gone` (section 3.2). */
  tokenExpiresAt: number;
};

export class Conn {
  readonly id = randomUUID();
  side: 'assist' | 'desk' | null = null;
  desk: DeskInfo | null = null;
  readonly openedAt = Date.now();
  lastInbound = Date.now();
  lastPingAt = Date.now();
  violations: number[] = [];
  queue: Promise<void> = Promise.resolve();
  /** The socket is gone (peer close, or our own close); replies become no-ops. */
  closed = false;
  /**
   * The server ended this connection on purpose (close(), rate-limit kick, shutdown): frames still queued are
   * dropped. A peer-initiated close does NOT set it, so frames received before the close are still handled
   * (e.g. the Desk's final `session.end` / `desk.consent revoked`), then onConnClosed runs.
   */
  terminated = false;
  readonly bucket = new TokenBucket(20, 60);
  /** Last time the cookie principal was re-validated against auth_session / user (section 7.2). */
  lastAuthCheckAt = Date.now();
  authCheckInFlight = false;
  /** `signal.forbidden` coalescing: per session id, when the last entry was written and how many were suppressed. */
  readonly forbidden = new Map<string, { writtenAt: number; suppressed: number }>();
  /** Timestamps of forbidden attempts in the last minute (closed `4403` beyond the limit). */
  forbiddenTimes: number[] = [];

  constructor(
    readonly ws: WebSocket,
    readonly ip: string,
    readonly userAgent: string | null,
    /** Resolved from the upgrade cookie; required for `assist.hello`. */
    public principal: Principal | null,
  ) {}

  get helloed(): boolean {
    return this.side !== null;
  }

  send(msg: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  /** Forwards an already-serialised frame verbatim (webrtc.* relay). */
  sendRaw(frame: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(frame);
  }

  error(code: SignalErrorCode, message: string, re?: string, details?: Record<string, unknown>): void {
    this.send({ t: 'error', ...(re !== undefined ? { re } : {}), code, message, ...(details ? { details } : {}) });
  }

  /** Records a rate violation; true when the connection has had `limit` of them within a minute. */
  strike(limit = 3): boolean {
    const now = Date.now();
    this.violations = this.violations.filter((t) => t > now - 60_000);
    this.violations.push(now);
    return this.violations.length >= limit;
  }

  close(code: number, reason = ''): void {
    this.terminated = true;
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }
}

export type Live = {
  id: string;
  orgId: string;
  tokenId: string;
  state: SessionState;
  path: SessionPath;
  assistConnId: string | null;
  deskConnId: string | null;
  chatCount: number;
  chatClosed: boolean;
  lastStatsAt: number;
  /** Last `session.path_changed` write (at most one per PATH_CHANGE_MIN_MS, section 7.3). */
  lastPathChangeAt: number;
  /** Desk file attestations already written, `${direction}:${fileId}` -> entry id (one per transfer). */
  deskAttested: Map<string, string>;
  /** Per-session budget for `desk.event` frames. */
  eventBucket: TokenBucket;
  timers: Map<string, NodeJS.Timeout>;
};

export function newLive(s: { id: string; orgId: string; tokenId: string; state: SessionState; path: SessionPath }): Live {
  return {
    id: s.id,
    orgId: s.orgId,
    tokenId: s.tokenId,
    state: s.state,
    path: s.path,
    assistConnId: null,
    deskConnId: null,
    chatCount: 0,
    chatClosed: false,
    lastStatsAt: 0,
    lastPathChangeAt: 0,
    deskAttested: new Map(),
    eventBucket: new TokenBucket(5, 20),
    timers: new Map(),
  };
}

export function setTimer(live: Live, name: string, ms: number, fn: () => void): void {
  clearTimer(live, name);
  const t = setTimeout(() => {
    live.timers.delete(name);
    fn();
  }, ms);
  t.unref?.();
  live.timers.set(name, t);
}

export function clearTimer(live: Live, name: string): void {
  const t = live.timers.get(name);
  if (t) clearTimeout(t);
  live.timers.delete(name);
}

export function clearTimers(live: Live): void {
  for (const t of live.timers.values()) clearTimeout(t);
  live.timers.clear();
}
