/**
 * WS `/signal` (contracts section 7): `ws` attached to the Fastify HTTP server. The hub owns the sockets, the
 * per-session registry (which connection is the `assist` / `desk` participant), heartbeats, frame limits and the
 * dispatch of every client message to the handlers in desk.ts, assist.ts and relay.ts.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ASSIST_CLIENT_TYPES,
  DESK_CLIENT_TYPES,
  isRegionServed,
  parseClientSignal,
  SESSION_COOKIE_NAME,
  WS_CLOSE,
  type ClientSignalMessage,
} from '@indiansassist/shared';
import type { TokenRow } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { canActOnToken } from '../lib/rbac.js';
import { principalFromCookieValue, unsignSessionCookie, type Principal } from '../plugins/auth.js';
import type { EndedSession } from '../services/session-end.js';
import {
  handleAssistAccept,
  handleAssistDeny,
  handleAssistHello,
  handleAssistResume,
  handleChatChannelOpen,
  handleSessionStats,
} from './assist.js';
import { closeExpiredWaitingDesks, refreshUserSockets, runAuthChecks } from './auth-watch.js';
import { Conn, type Live } from './conn.js';
import { handleDeskConsent, handleDeskEvent, handleDeskHello, handleDeskKnock, handleDeskPoll } from './desk.js';
import { onConnClosed, onSessionEnded, onTokenRevoked } from './lifecycle.js';
import { handleChatMessage, handleSessionEnd, handleWebrtc } from './relay.js';

type Handler = (hub: SignalHub, conn: Conn, msg: never) => Promise<void>;

const HANDLERS: Partial<Record<ClientSignalMessage['t'], Handler>> = {
  'desk.poll': handleDeskPoll as Handler,
  'desk.knock': handleDeskKnock as Handler,
  'desk.consent': handleDeskConsent as Handler,
  'desk.event': handleDeskEvent as Handler,
  'assist.accept': handleAssistAccept as Handler,
  'assist.deny': handleAssistDeny as Handler,
  'assist.resume': handleAssistResume as Handler,
  'chat.channel_open': handleChatChannelOpen as Handler,
  'session.stats': handleSessionStats as Handler,
  'webrtc.offer': handleWebrtc as Handler,
  'webrtc.answer': handleWebrtc as Handler,
  'webrtc.ice': handleWebrtc as Handler,
  'chat.message': handleChatMessage as Handler,
  'session.end': handleSessionEnd as Handler,
};

const ASSIST_TYPES = new Set<string>(ASSIST_CLIENT_TYPES);
const DESK_TYPES = new Set<string>(DESK_CLIENT_TYPES);

export class SignalHub {
  readonly conns = new Map<string, Conn>();
  readonly live = new Map<string, Live>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private tickTimer: NodeJS.Timeout | null = null;
  private app: FastifyInstance | null = null;

  constructor(readonly ctx: AppContext) {}

  attach(app: FastifyInstance): void {
    this.app = app;
    app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.onUpgrade(req, socket, head).catch((err: unknown) => {
        this.ctx.log.error({ err }, 'ws upgrade failed');
        reject(socket, 500, 'Internal Server Error');
      });
    });
    this.tickTimer = setInterval(() => this.tick(), this.ctx.timing.tickMs);
    this.tickTimer.unref?.();
  }

  private clientIp(req: IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    if (this.ctx.config.trustProxy && typeof xff === 'string' && xff.trim() !== '') return xff.split(',')[0]!.trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/signal') return reject(socket, 404, 'Not Found');
    const origin = req.headers['origin'];
    if (origin !== undefined && origin !== this.ctx.config.webOrigin) return reject(socket, 403, 'Forbidden');
    const ip = this.clientIp(req);
    const lim = this.ctx.limiter.hit(`ws-upgrade:${ip}`, 60, 60_000);
    const pending = [...this.conns.values()].filter((c) => c.ip === ip && !c.helloed).length;
    if (!lim.allowed || (!this.ctx.config.rateLimitDisabled && pending >= 20)) {
      this.ctx.metrics.rateLimited.inc();
      return reject(socket, 429, 'Too Many Requests');
    }
    let principal: Principal | null = null;
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader && this.app) {
      const signed = this.app.parseCookie(cookieHeader)[SESSION_COOKIE_NAME];
      principal = await principalFromCookieValue(this.ctx, unsignSessionCookie(this.app, signed));
      if (principal && !isRegionServed(principal.org.dataRegion, this.ctx.config.servedRegions)) {
        this.ctx.log.error({ orgId: principal.org.id }, 'assist org region is not served by this node');
        return reject(socket, 421, 'Misdirected Request');
      }
    }
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(new Conn(ws, ip, ua, principal), ws));
  }

  private onConnection(conn: Conn, ws: WebSocket): void {
    this.conns.set(conn.id, conn);
    this.ctx.metrics.wsConnections.inc();
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => {
      conn.closed = true;
      if (!this.conns.delete(conn.id)) return;
      this.ctx.metrics.wsConnections.dec();
      conn.queue = conn.queue.then(() => onConnClosed(this, conn)).catch((err: unknown) => this.logErr(conn, err));
    });
    ws.on('error', (err) => this.ctx.log.warn({ connectionId: conn.id, err }, 'ws error'));
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    conn.lastInbound = Date.now();
    if (!this.ctx.config.rateLimitDisabled && !conn.bucket.take()) {
      this.ctx.metrics.rateLimited.inc();
      const now = Date.now();
      conn.violations = conn.violations.filter((t) => t > now - 60_000);
      conn.violations.push(now);
      conn.error('rate_limited', 'too many frames', undefined, { retryAfterSec: 1 });
      if (conn.violations.length >= 3) conn.close(WS_CLOSE.rateLimited, 'rate limited');
      return;
    }
    if (isBinary) return conn.error('bad_payload', 'text frames only');
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data).toString('utf8');
    conn.queue = conn.queue.then(() => this.dispatch(conn, text)).catch((err: unknown) => this.logErr(conn, err));
  }

  private logErr(conn: Conn, err: unknown): void {
    this.ctx.log.error({ connectionId: conn.id, err }, 'signal handler failed');
  }

  private async dispatch(conn: Conn, text: string): Promise<void> {
    // Frames received before a peer-initiated close are still handled (the Desk's last `session.end`); only a
    // connection the server terminated drops what is queued. Replies to a closed socket are no-ops.
    if (conn.terminated) return;
    const parsed = parseClientSignal(text);
    if (!parsed.ok) return conn.error(parsed.code, parsed.message, parsed.re);
    const msg = parsed.msg;
    const re = msg.id;
    if (msg.t === 'ping') return conn.send({ t: 'pong', ...(re !== undefined ? { re } : {}) });
    if (msg.t === 'pong') return;
    const hello = msg.t === 'assist.hello' || msg.t === 'desk.hello';
    if (hello && conn.helloed) return conn.error('bad_state', 'hello already completed', re);
    if (!hello && !conn.side) return conn.error('not_authenticated', 'send assist.hello or desk.hello first', re);
    let handler: Handler | undefined;
    if (msg.t === 'assist.hello') handler = handleAssistHello as Handler;
    else if (msg.t === 'desk.hello') handler = handleDeskHello as Handler;
    else {
      const allowed = conn.side === 'assist' ? ASSIST_TYPES : DESK_TYPES;
      if (!allowed.has(msg.t)) return conn.error('forbidden', `${msg.t} is not allowed for this side`, re);
      handler = HANDLERS[msg.t];
    }
    if (!handler) return conn.error('unknown_type', 'unknown message type', re);
    try {
      await handler(this, conn, msg as never);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (hello) {
        // A failed hello must never leave a helloed socket without a reply (it would sit on "Connecting").
        if (code !== 'invalid_transition' && code !== 'already_ended') this.logErr(conn, err);
        conn.side = null;
        conn.desk = null;
        conn.error('session_not_found', 'the session could not be joined; open the link again', re);
        return conn.close(WS_CLOSE.forbidden, 'hello failed');
      }
      if (code === 'invalid_transition' || code === 'already_ended')
        return conn.error('bad_state', 'session state changed', re);
      this.logErr(conn, err);
      conn.error('bad_state', 'request could not be processed', re);
    }
  }

  /** Hello timeout, heartbeat pings and the 60 s idle close (section 7.2). */
  private tick(): void {
    const now = Date.now();
    const t = this.ctx.timing;
    runAuthChecks(this, now);
    closeExpiredWaitingDesks(this, now);
    for (const c of this.conns.values()) {
      if (c.closed) continue;
      if (!c.helloed && now - c.openedAt > t.helloTimeoutMs) {
        c.close(WS_CLOSE.timeout, 'hello timeout');
        continue;
      }
      if (now - c.lastInbound > t.idleTimeoutMs) {
        c.close(WS_CLOSE.timeout, 'heartbeat timeout');
        continue;
      }
      if (now - c.lastPingAt >= t.pingIntervalMs) {
        c.lastPingAt = now;
        c.send({ t: 'ping' });
      }
    }
  }

  // ---------- registry helpers ----------

  assistConns(): Conn[] {
    return [...this.conns.values()].filter((c) => c.side === 'assist' && c.principal !== null && !c.closed);
  }

  /** Helloed Assist sockets that may act on (and are subscribed to knocks of) a token. */
  assistsForToken(tok: Pick<TokenRow, 'orgId' | 'createdBy'>): Conn[] {
    return this.assistConns().filter((c) => canActOnToken(c.principal!.user, tok));
  }

  deskConnsForToken(tokenId: string): Conn[] {
    return [...this.conns.values()].filter((c) => c.side === 'desk' && c.desk?.tokenId === tokenId && !c.closed);
  }

  conn(id: string | null | undefined): Conn | null {
    if (!id) return null;
    const c = this.conns.get(id);
    return c && !c.closed ? c : null;
  }

  // ---------- API used by REST services ----------

  chatCount(sessionId: string): number {
    return this.live.get(sessionId)?.chatCount ?? 0;
  }

  async sessionEnded(ended: EndedSession): Promise<void> {
    await onSessionEnded(this, ended);
  }

  tokenRevoked(tokenId: string): void {
    onTokenRevoked(this, tokenId);
  }

  /** Pushes `session.recording { recording: true }` to the Desk of a session (section 6.8). */
  pushRecording(sessionId: string): void {
    const live = this.live.get(sessionId);
    this.conn(live?.deskConnId)?.send({ t: 'session.recording', sessionId, recording: true });
  }

  /**
   * Closes every authenticated socket of a user (disabled mid-session, password change: 4401), optionally keeping
   * the sockets opened with one cookie session (the one that changed the password).
   */
  closeUserSockets(userId: string, code: number, opts: { exceptAuthSessionId?: string } = {}): void {
    for (const c of [...this.conns.values()]) {
      const p = c.principal;
      if (!p || p.user.id !== userId || c.closed) continue;
      if (opts.exceptAuthSessionId !== undefined && p.authSession.id === opts.exceptAuthSessionId) continue;
      c.error('not_authenticated', 'your sign-in is no longer valid');
      c.close(code, 'signed out');
    }
  }

  /** Closes the sockets opened with the given cookie sessions (logout: 4401). */
  closeSocketsForAuthSessions(authSessionIds: readonly string[], code: number): void {
    const ids = new Set(authSessionIds);
    for (const c of [...this.conns.values()]) {
      if (!c.principal || c.closed || !ids.has(c.principal.authSession.id)) continue;
      c.error('not_authenticated', 'you signed out');
      c.close(code, 'signed out');
    }
  }

  /** Re-reads the principal of every socket of a user now (a role change applies before the reply). */
  async refreshUser(userId: string): Promise<void> {
    await refreshUserSockets(this, userId);
  }

  async close(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const l of this.live.values()) for (const t of l.timers.values()) clearTimeout(t);
    this.live.clear();
    for (const c of this.conns.values()) {
      c.closed = true;
      c.terminated = true;
      c.ws.terminate();
    }
    this.conns.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}
