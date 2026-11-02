/**
 * WS `/signal` (contracts section 7): `ws` attached to the Fastify HTTP server. The hub owns the sockets, the
 * per-session registry (which connection is the `assist` / `desk` participant), heartbeats, frame limits and the
 * dispatch of every client message to the handlers in desk.ts, assist.ts and relay.ts. With a multi-node presence
 * driver the bridge (bridge.ts) forwards frames of sessions owned by another node and fans org / user events out to
 * every node (section 7.6 N1); the REST-facing API is in hub-api.ts.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  ASSIST_CLIENT_TYPES,
  BUCKET_EXEMPT_TYPES,
  CAMERA_CLIENT_TYPES,
  DESK_CLIENT_TYPES,
  RECORDER_CLIENT_TYPES,
  isRegionServed,
  parseClientSignal,
  SESSION_COOKIE_NAME,
  WS_CLOSE,
  type ClientSignalMessage,
} from '@indiansassist/shared';
import type { TokenRow } from '@indiansassist/db';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { isExtensionOrigin } from '../config.js';
import type { AppContext } from '../context.js';
import { canActOnToken } from '../lib/rbac.js';
import { isOrgErasing, principalFromCookieValue, unsignSessionCookie, type Principal } from '../plugins/auth.js';
import {
  handleAssistAccept,
  handleAssistDeny,
  handleAssistHello,
  handleAssistResume,
  handleChatChannelOpen,
  handleSessionStats,
} from './assist.js';
import { closeExpiredWaitingDesks, runAuthChecks } from './auth-watch.js';
import { Bridge } from './bridge.js';
import { Conn, wsTransport, type Live } from './conn.js';
import { handleDeskConsent, handleDeskEvent, handleDeskHello, handleDeskKnock, handleDeskPoll } from './desk.js';
import { handleDeskConsentBackstage, handleDeskConsentLevel } from './desk-consent.js';
import { handleDeskConsentClipboard, handleDeskConsentMonitors } from './desk-p3.js';
import { handleDeskElevation } from './handover.js';
import { handleControlRelay, handleMirrorRelay } from './relay-p2.js';
import { ForbiddenGuard } from './forbidden.js';
import { HubApi } from './hub-api.js';
import { onConnClosed } from './lifecycle.js';
import { handleChatMessage, handleSessionEnd, handleWebrtc } from './relay.js';
import { handleRecorderHello, handleRecorderJoin, handleRecorderLeave } from './recorder.js';
import { DeviceHub } from './device.js';
import { handleCameraHello, handleCameraReady, handleCameraStop } from './camera.js';

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
  'desk.consent_level': handleDeskConsentLevel as Handler,
  'desk.consent_backstage': handleDeskConsentBackstage as Handler,
  'desk.consent_clipboard': handleDeskConsentClipboard as Handler,
  'desk.consent_monitors': handleDeskConsentMonitors as Handler,
  'desk.elevation': handleDeskElevation as Handler,
  'mirror.relay': handleMirrorRelay as Handler,
  'control.relay': handleControlRelay as Handler,
  'recorder.join': handleRecorderJoin as Handler,
  'recorder.leave': handleRecorderLeave as Handler,
  // Phase F section 6.4 (camera stream, signal/camera.ts).
  'camera.ready': handleCameraReady as Handler,
  'camera.stop': handleCameraStop as Handler,
};

const ASSIST_TYPES = new Set<string>(ASSIST_CLIENT_TYPES);
const DESK_TYPES = new Set<string>(DESK_CLIENT_TYPES);
const RECORDER_TYPES = new Set<string>(RECORDER_CLIENT_TYPES);
const CAMERA_TYPES = new Set<string>(CAMERA_CLIENT_TYPES);
const EXEMPT_TYPES = new Set<string>(BUCKET_EXEMPT_TYPES);
const T_RE = /^\s*\{\s*"t"\s*:\s*"([a-z._]{1,40})"/;
/** Phase C section 3.1: native Desks (agent / Android host) get a larger un-helloed socket cap per IP. */
const AGENT_UA_RE = /^IndiansAssist-(Agent|Android)\//;

/** The `t` of a text frame for the Y25 bucket exemption (a cheap prefix match, then a parse as fallback). */
function frameType(text: string): string | null {
  const m = T_RE.exec(text);
  if (m) return m[1]!;
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text) as { t?: unknown };
    return typeof v?.t === 'string' ? v.t : null;
  } catch {
    return null;
  }
}

type Tok = Pick<TokenRow, 'orgId' | 'createdBy'>;

export class SignalHub extends HubApi {
  readonly conns = new Map<string, Conn>();
  readonly live = new Map<string, Live>();
  /** `signal.forbidden` budget per principal (SEC-05). */
  readonly forbidden = new ForbiddenGuard();
  readonly bridge: Bridge;
  /** Phase D section 3.4: the `/signal/device` sockets of the installed services. */
  readonly devices: DeviceHub;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private tickTimer: NodeJS.Timeout | null = null;
  private app: FastifyInstance | null = null;

  constructor(readonly ctx: AppContext) {
    super();
    this.bridge = new Bridge(this);
    this.devices = new DeviceHub(this);
  }

  /** Subscribes the bridge channels (multi-node presence only); awaited by buildApp before serving. */
  async start(): Promise<void> {
    await this.bridge.start();
  }

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
    // Phase D W44: the installed service connects on its own upgrade path; `/signal` is unchanged.
    if (path === '/signal/device') return this.devices.onUpgrade(req, socket, head, this.clientIp(req));
    if (path !== '/signal') return reject(socket, 404, 'Not Found');
    const origin = req.headers['origin'];
    // Y21: the web origin, or a listed extension origin (Desk messages only, never a cookie principal). Phase C
    // section 3.1: an upgrade WITHOUT Origin (native agent, recorder) is likewise `deskOnly` with a null principal.
    const extensionOrigin = origin !== undefined && origin !== this.ctx.config.webOrigin && isExtensionOrigin(this.ctx.config, origin);
    if (origin !== undefined && origin !== this.ctx.config.webOrigin && !extensionOrigin) return reject(socket, 403, 'Forbidden');
    const deskOnly = extensionOrigin || origin === undefined;
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const ip = this.clientIp(req);
    const lim = await this.ctx.limiter.hit(`ws-upgrade:${ip}`, 60, 60_000);
    const isAgent = ua !== null && AGENT_UA_RE.test(ua);
    const pending = [...this.conns.values()].filter((c) => c.ip === ip && !c.helloed && (c.userAgent !== null && AGENT_UA_RE.test(c.userAgent)) === isAgent).length;
    if (!lim.allowed || (!this.ctx.config.rateLimitDisabled && pending >= (isAgent ? 60 : 20))) {
      this.ctx.metrics.rateLimited.inc();
      return reject(socket, 429, 'Too Many Requests');
    }
    let principal: Principal | null = null;
    const cookieHeader = deskOnly ? undefined : req.headers['cookie'];
    if (cookieHeader && this.app) {
      const signed = this.app.parseCookie(cookieHeader)[SESSION_COOKIE_NAME];
      principal = await principalFromCookieValue(this.ctx, unsignSessionCookie(this.app, signed));
      if (principal && !isRegionServed(principal.org.dataRegion, this.ctx.config.servedRegions)) {
        this.ctx.log.error({ orgId: principal.org.id }, 'assist org region is not served by this node');
        return reject(socket, 421, 'Misdirected Request');
      }
      // Phase F section 5.3 step 1: the Assists of an org whose erasure is executing get no socket (409 org_erasing).
      if (principal && isOrgErasing(principal.org)) return reject(socket, 409, 'Conflict');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Conn(wsTransport(ws), ip, ua, principal);
      conn.deskOnly = deskOnly;
      conn.extensionOrigin = extensionOrigin;
      this.onConnection(conn, ws);
    });
  }

  private onConnection(conn: Conn, ws: WebSocket): void {
    this.conns.set(conn.id, conn);
    this.ctx.metrics.wsConnections.inc();
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => {
      conn.closed = true;
      if (!this.conns.delete(conn.id)) return;
      this.ctx.metrics.wsConnections.dec();
      this.bridge.socketClosed(conn);
      conn.queue = conn.queue.then(() => onConnClosed(this, conn)).catch((err: unknown) => this.logErr(conn, err));
    });
    ws.on('error', (err) => this.ctx.log.warn({ connectionId: conn.id, err }, 'ws error'));
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    conn.lastInbound = Date.now();
    const text = isBinary
      ? ''
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
    const t = isBinary ? null : frameType(text);
    const bucket = t !== null && EXEMPT_TYPES.has(t) ? conn.exemptBucket : conn.bucket;
    if (!this.ctx.config.rateLimitDisabled && !bucket.take()) {
      this.ctx.metrics.rateLimited.inc();
      const now = Date.now();
      conn.violations = conn.violations.filter((t) => t > now - 60_000);
      conn.violations.push(now);
      conn.error('rate_limited', 'too many frames', undefined, { retryAfterSec: 1 });
      if (conn.violations.length >= 3) conn.close(WS_CLOSE.rateLimited, 'rate limited');
      return;
    }
    if (isBinary) return conn.error('bad_payload', 'text frames only');
    conn.queue = conn.queue.then(() => this.dispatch(conn, text)).catch((err: unknown) => this.logErr(conn, err));
  }

  private logErr(conn: Conn, err: unknown): void {
    this.ctx.log.error({ connectionId: conn.id, err }, 'signal handler failed');
  }

  /** Handles one frame of a local socket, or of a RemoteConn on its session's owner node (bridge.ts). */
  async dispatch(conn: Conn, text: string): Promise<void> {
    // Frames received before a peer-initiated close are still handled (the Desk's last `session.end`); only a
    // connection the server terminated drops what is queued. Replies to a closed socket are no-ops.
    if (conn.terminated) return;
    const parsed = parseClientSignal(text);
    if (!parsed.ok) return conn.error(parsed.code, parsed.message, parsed.re);
    const msg = parsed.msg;
    const re = msg.id;
    if (msg.t === 'ping') return conn.send({ t: 'pong', ...(re !== undefined ? { re } : {}) });
    if (msg.t === 'pong') return;
    const hello = msg.t === 'assist.hello' || msg.t === 'desk.hello' || msg.t === 'recorder.hello' || msg.t === 'camera.hello';
    if (hello && conn.helloed) return conn.error('bad_state', 'hello already completed', re);
    // Phase F section 6.4: the phone page uses the web Origin, so a camera never says hello on a Desk-only socket.
    if ((msg.t === 'assist.hello' || msg.t === 'camera.hello') && conn.deskOnly) {
      conn.error('forbidden', 'this socket may only connect as a Desk', re);
      return conn.close(WS_CLOSE.forbidden, 'forbidden');
    }
    if (!hello && !conn.side) return conn.error('not_authenticated', 'send assist.hello or desk.hello first', re);
    let handler: Handler | undefined;
    if (msg.t === 'assist.hello') handler = handleAssistHello as Handler;
    else if (msg.t === 'desk.hello') handler = handleDeskHello as Handler;
    else if (msg.t === 'recorder.hello') handler = handleRecorderHello as Handler;
    else if (msg.t === 'camera.hello') handler = handleCameraHello as Handler;
    else {
      const allowed =
        conn.side === 'assist'
          ? ASSIST_TYPES
          : conn.side === 'recorder'
            ? RECORDER_TYPES
            : conn.side === 'camera'
              ? CAMERA_TYPES
              : DESK_TYPES;
      if (!allowed.has(msg.t)) return conn.error('forbidden', `${msg.t} is not allowed for this side`, re);
      handler = HANDLERS[msg.t];
    }
    if (!handler) return conn.error('unknown_type', 'unknown message type', re);
    if (!hello && this.bridge.on) {
      const owner = await this.bridge.ownerFor(conn, 'sessionId' in msg ? msg.sessionId : undefined);
      if (owner) return this.bridge.forward(owner, conn, text);
    }
    try {
      await handler(this, conn, msg as never);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (hello) return this.helloFailed(conn, err, re);
      if (code === 'invalid_transition' || code === 'already_ended')
        return conn.error('bad_state', 'session state changed', re);
      this.logErr(conn, err);
      conn.error('bad_state', 'request could not be processed', re);
    }
  }

  /** A failed hello must never leave a helloed socket without a reply (it would sit on "Connecting"). */
  helloFailed(conn: Conn, err: unknown, re: string | undefined): void {
    const code = (err as { code?: string }).code;
    if (code !== 'invalid_transition' && code !== 'already_ended') this.logErr(conn, err);
    conn.side = null;
    conn.desk = null;
    conn.error('session_not_found', 'the session could not be joined; open the link again', re);
    conn.close(WS_CLOSE.forbidden, 'hello failed');
  }

  /** Hello timeout, heartbeat pings and the 60 s idle close (section 7.2). */
  private tick(): void {
    const now = Date.now();
    const t = this.ctx.timing;
    runAuthChecks(this, now);
    closeExpiredWaitingDesks(this, now);
    this.bridge.tick(now);
    this.devices.tick(now);
    this.forbidden.prune(now);
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

  /** Helloed Assist sockets of this node (knock fan-out goes to the real sockets, never to RemoteConns). */
  assistConns(): Conn[] {
    return [...this.conns.values()].filter((c) => c.side === 'assist' && c.principal !== null && !c.closed);
  }

  /** Helloed Assist sockets of this node that may act on (and are subscribed to knocks of) a token. */
  assistsForToken(tok: Tok): Conn[] {
    return this.assistConns().filter((c) => canActOnToken(c.principal!.user, tok));
  }

  /** Sends to every Assist socket of the cluster that may act on the token, except connection `except`. */
  toAssists(tok: Tok, frame: Record<string, unknown>, except: string | null = null): void {
    this.deliverToAssists(tok, frame, except);
    this.bridge.broadcast({ e: 'assists', tok: { orgId: tok.orgId, createdBy: tok.createdBy }, frame, except });
  }

  deliverToAssists(tok: Tok, frame: Record<string, unknown>, except: string | null): void {
    for (const a of this.assistsForToken(tok)) if (a.id !== except) a.send(frame);
  }

  /** "Eligible Assist online" (section 7.5): on this node, or on another live node per the presence registry. */
  async techOnline(tok: Tok): Promise<boolean> {
    return this.assistsForToken(tok).length > 0 || (await this.bridge.remoteAssistFor(tok));
  }

  /** Local sockets and the RemoteConns of sessions owned here. */
  allConns(): Conn[] {
    return [...this.conns.values(), ...this.bridge.remotes.values()];
  }

  /** Desk sockets whose logic runs on this node: local ones not piped elsewhere, and bridged ones owned here. */
  deskConns(): Conn[] {
    return this.allConns().filter((c) => c.side === 'desk' && !c.closed && (c.remote || c.pipeTo === null));
  }

  deskConnsForToken(tokenId: string, opts: { includePiped?: boolean } = {}): Conn[] {
    const pool = opts.includePiped ? this.allConns().filter((c) => c.side === 'desk' && !c.closed) : this.deskConns();
    return pool.filter((c) => c.desk?.tokenId === tokenId);
  }

  /** A participant by connection id: a local socket or a RemoteConn. */
  conn(id: string | null | undefined): Conn | null {
    if (!id) return null;
    const c = this.conns.get(id) ?? this.bridge.remotes.get(id);
    return c && !c.closed ? c : null;
  }

  localConn(id: string): Conn | null {
    const c = this.conns.get(id);
    return c && !c.closed ? c : null;
  }

  async close(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.bridge.stop();
    await this.devices.close();
    for (const l of this.live.values()) for (const t of l.timers.values()) clearTimeout(t);
    this.live.clear();
    for (const c of this.conns.values()) {
      c.closed = true;
      c.terminated = true;
      c.transport.terminate();
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
