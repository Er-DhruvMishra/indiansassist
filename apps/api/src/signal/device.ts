/**
 * Phase D `/signal/device` (docs/specs/phase-d-contracts.md sections 3.4, 3.6, 13.5): the installed service's
 * persistent socket. A separate upgrade path on the same api nodes: an absent `Origin` is required (present -> 403
 * before the upgrade), cookies are ignored, the server sends `device.challenge` once per socket and the device answers
 * `device.hello` signed with its identity key within 10 s (else close 4408). Only the `device.*`, `wake.*` and `amt.*`
 * messages travel here; `assist.hello` / `desk.hello` / `recorder.hello` answer `error forbidden` + close 4403. No
 * device frame is ever sent on `/signal`. A device is a presence (`ia:dev:<id>`), not a session; pushes to it are
 * routed to the node holding its socket (rule 3.6c).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { parseDeviceClientMessage, WS_CLOSE, type DeviceClientMessage, type SignalErrorCode } from '@indiansassist/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { TokenBucket } from '../limiter.js';
import { clearDevicePresence, getDevicePresence } from '../fleet/common.js';
import { handleDeviceMessage, onDeviceSocketClosed } from '../fleet/device-socket.js';
import { ManifestPush } from '../fleet/manifest-push.js';
import type { SignalHub } from './hub.js';

/** Section 3.4: `device.hello` within 10 s of the challenge. */
export const DEVICE_HELLO_TIMEOUT_MS = 10_000;
/** A device socket with no inbound frame for this long is closed (heartbeat every 30 s +- 5 s). */
export const DEVICE_IDLE_MS = 120_000;

const FORBIDDEN_HELLOS = new Set(['assist.hello', 'desk.hello', 'recorder.hello']);

export class DeviceConn {
  readonly id = randomUUID();
  readonly openedAt = Date.now();
  readonly challenge = randomBytes(32).toString('base64url');
  lastInbound = Date.now();
  lastSeenWrite = 0;
  queue: Promise<void> = Promise.resolve();
  closed = false;
  /** Set by a verified `device.hello`. */
  deviceId: string | null = null;
  orgId: string | null = null;
  readonly bucket = new TokenBucket(20, 60);

  constructor(
    private readonly ws: WebSocket,
    readonly ip: string,
  ) {}

  get helloed(): boolean {
    return this.deviceId !== null;
  }

  send(msg: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  error(code: SignalErrorCode, message: string, re?: string, details?: Record<string, unknown>): void {
    this.send({ t: 'error', ...(re !== undefined ? { re } : {}), code, message, ...(details ? { details } : {}) });
  }

  close(code: number, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }

  terminate(): void {
    this.closed = true;
    this.ws.terminate();
  }
}

export class DeviceHub {
  readonly conns = new Map<string, DeviceConn>();
  /** deviceId -> the helloed socket of this node. */
  readonly byDevice = new Map<string, DeviceConn>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  /** Section 13.5 `DEVICE_HELLO_RATE`: `device.hello`s verified per second on this node. */
  readonly helloBucket: TokenBucket;
  /** Rule 9.3: `device.playbooks` to an org's connected devices when its catalogue changes, coalesced per org. */
  readonly manifests: ManifestPush;

  constructor(readonly hub: SignalHub) {
    const rate = hub.ctx.config.fleet.deviceHelloRate;
    this.helloBucket = new TokenBucket(rate, rate);
    this.manifests = new ManifestPush(hub.ctx);
  }

  get ctx() {
    return this.hub.ctx;
  }

  /** The upgrade of `/signal/device` (called by the hub's upgrade router). */
  async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): Promise<void> {
    if (req.headers['origin'] !== undefined) return reject(socket, 403, 'Forbidden');
    const lim = await this.ctx.limiter.hit(`ws-device-upgrade:${ip}`, 600, 60_000);
    if (!lim.allowed) {
      this.ctx.metrics.rateLimited.inc();
      return reject(socket, 429, 'Too Many Requests');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(new DeviceConn(ws, ip), ws));
  }

  private onConnection(conn: DeviceConn, ws: WebSocket): void {
    this.conns.set(conn.id, conn);
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(conn, data, isBinary));
    ws.on('close', () => {
      conn.closed = true;
      if (!this.conns.delete(conn.id)) return;
      conn.queue = conn.queue.then(() => this.socketClosed(conn)).catch((err: unknown) => this.logErr(conn, err));
    });
    ws.on('error', (err) => this.ctx.log.warn({ connectionId: conn.id, err }, 'device ws error'));
    conn.send({ t: 'device.challenge', serverChallenge: conn.challenge, ts: Date.now() });
  }

  private onMessage(conn: DeviceConn, data: RawData, isBinary: boolean): void {
    conn.lastInbound = Date.now();
    if (isBinary) return conn.error('bad_payload', 'text frames only');
    if (!this.ctx.config.rateLimitDisabled && !conn.bucket.take()) {
      this.ctx.metrics.rateLimited.inc();
      return conn.error('rate_limited', 'too many frames', undefined, { retryAfterSec: 1 });
    }
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
    conn.queue = conn.queue.then(() => this.dispatch(conn, text)).catch((err: unknown) => this.logErr(conn, err));
  }

  private logErr(conn: DeviceConn, err: unknown): void {
    this.ctx.log.error({ connectionId: conn.id, deviceId: conn.deviceId, err }, 'device handler failed');
  }

  private async dispatch(conn: DeviceConn, text: string): Promise<void> {
    if (conn.closed) return;
    let rawT: unknown;
    try {
      rawT = (JSON.parse(text) as { t?: unknown })?.t;
    } catch {
      rawT = undefined;
    }
    if (typeof rawT === 'string' && FORBIDDEN_HELLOS.has(rawT)) {
      conn.error('forbidden', `${rawT} is not accepted on /signal/device`);
      return conn.close(WS_CLOSE.forbidden, 'forbidden');
    }
    const parsed = parseDeviceClientMessage(text);
    if (!parsed.ok) return conn.error(parsed.code, parsed.message, parsed.re);
    const msg: DeviceClientMessage = parsed.msg;
    if (msg.t === 'ping') return conn.send({ t: 'pong', ...(msg.id !== undefined ? { re: msg.id } : {}) });
    if (msg.t === 'pong') return;
    if (msg.t === 'device.hello' && conn.helloed) return conn.error('bad_state', 'hello already completed', msg.id);
    if (msg.t !== 'device.hello' && !conn.helloed) return conn.error('not_authenticated', 'send device.hello first', msg.id);
    try {
      await handleDeviceMessage(this, conn, msg);
    } catch (err) {
      this.logErr(conn, err);
      conn.error('bad_state', 'request could not be processed', msg.id);
    }
  }

  private async socketClosed(conn: DeviceConn): Promise<void> {
    if (!conn.deviceId) return;
    if (this.byDevice.get(conn.deviceId) === conn) this.byDevice.delete(conn.deviceId);
    await clearDevicePresence(this.ctx, conn.deviceId, conn.id);
    await onDeviceSocketClosed(this, conn);
  }

  /** Registers a verified socket for `deviceId`; a previous socket of the same device on this node is replaced. */
  register(conn: DeviceConn, deviceId: string, orgId: string): void {
    const prev = this.byDevice.get(deviceId);
    conn.deviceId = deviceId;
    conn.orgId = orgId;
    this.byDevice.set(deviceId, conn);
    if (prev && prev !== conn) prev.close(WS_CLOSE.normal, 'replaced by a newer connection');
  }

  /** Delivers to a socket of this node; false when the device has none here. */
  deliverLocal(deviceId: string, frame: Record<string, unknown>): boolean {
    const c = this.byDevice.get(deviceId);
    if (!c || c.closed) return false;
    c.send(frame);
    return true;
  }

  /**
   * Pushes an S->D frame to a device wherever its socket is (rule 3.6c): this node, or the owner node named by the
   * presence entry through the bridge. False when the device is offline.
   */
  async push(deviceId: string, frame: Record<string, unknown>): Promise<boolean> {
    if (this.deliverLocal(deviceId, frame)) return true;
    const p = await getDevicePresence(this.ctx, deviceId);
    if (!p || p.nodeId === this.ctx.config.nodeId || !this.hub.bridge.on || !(await this.ctx.presence.isNodeAlive(p.nodeId))) return false;
    this.hub.bridge.toNode(p.nodeId, { k: 'device', deviceId, frame });
    return true;
  }

  /** Closes a device's socket (disable / retire / deregister) with `error <code>` + close 4412, on any node. */
  async kick(deviceId: string, code: 'device_disabled' | 'device_unauthenticated', message: string): Promise<void> {
    if (this.kickLocal(deviceId, code, message)) return;
    const p = await getDevicePresence(this.ctx, deviceId);
    if (p && p.nodeId !== this.ctx.config.nodeId && this.hub.bridge.on) this.hub.bridge.toNode(p.nodeId, { k: 'device-kick', deviceId, code, message });
  }

  kickLocal(deviceId: string, code: 'device_disabled' | 'device_unauthenticated', message: string): boolean {
    const c = this.byDevice.get(deviceId);
    if (!c || c.closed) return false;
    c.error(code, message);
    c.close(WS_CLOSE.deviceUnauthenticated, code);
    return true;
  }

  /** Hub tick: the 10 s hello deadline and the idle close. */
  tick(now: number): void {
    for (const c of this.conns.values()) {
      if (c.closed) continue;
      if (!c.helloed && now - c.openedAt > DEVICE_HELLO_TIMEOUT_MS) c.close(WS_CLOSE.timeout, 'hello timeout');
      else if (now - c.lastInbound > DEVICE_IDLE_MS) c.close(WS_CLOSE.timeout, 'heartbeat timeout');
    }
  }

  async close(): Promise<void> {
    await this.manifests.close();
    for (const c of this.conns.values()) c.terminate();
    this.conns.clear();
    this.byDevice.clear();
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
