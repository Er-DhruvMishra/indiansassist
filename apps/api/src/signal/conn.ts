/**
 * One `/signal` socket and the per-session live registry entry (contracts section 7.2). A Conn talks through a
 * Transport: the local WebSocket, or (on the node that owns a session) the presence bridge to the node that holds
 * the real socket (section 7.6 N1, bridge.ts).
 */
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

/** Where a Conn's frames go. */
export interface Transport {
  isOpen(): boolean;
  send(frame: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export function wsTransport(ws: WebSocket): Transport {
  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: (frame) => ws.send(frame),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
}

/** Most session ids one socket remembers a remote owner for. */
const MAX_ROUTES = 64;

export class Conn {
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
  /** A proxy, on a session's owner node, for a socket held by another node (bridge.ts). */
  readonly remote: boolean = false;
  /** Desk socket resumed onto a session owned by another node: every frame after hello is forwarded there. */
  pipeTo: string | null = null;
  /** Nodes this socket's frames were forwarded to (told `closed` when the socket goes). */
  readonly pipes = new Set<string>();
  /** Assist socket: session id -> owner node for sessions owned by another node. */
  readonly routes = new Map<string, string>();

  constructor(
    readonly transport: Transport,
    readonly ip: string,
    readonly userAgent: string | null,
    /** Resolved from the upgrade cookie; required for `assist.hello`. */
    public principal: Principal | null,
    readonly id: string = randomUUID(),
  ) {}

  route(sessionId: string, nodeId: string): void {
    if (this.routes.size >= MAX_ROUTES && !this.routes.has(sessionId)) {
      const oldest = this.routes.keys().next().value;
      if (oldest !== undefined) this.routes.delete(oldest);
    }
    this.routes.set(sessionId, nodeId);
  }

  get helloed(): boolean {
    return this.side !== null;
  }

  send(msg: Record<string, unknown>): void {
    if (this.closed || !this.transport.isOpen()) return;
    this.transport.send(JSON.stringify(msg));
  }

  /** Forwards an already-serialised frame verbatim (webrtc.* relay). */
  sendRaw(frame: string): void {
    if (this.closed || !this.transport.isOpen()) return;
    this.transport.send(frame);
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
      this.transport.close(code, reason);
    } catch {
      this.transport.terminate();
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
