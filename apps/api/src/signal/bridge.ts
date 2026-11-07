/**
 * Multi-node signaling bridge (contracts sections 7.6 N1, 10.2; prd-F2). Active only with a presence driver that sees
 * the whole cluster (`presence.multiNode`, the `redis` driver); with the single-node `memory` driver every method is
 * a no-op and the hub behaves exactly as one process.
 *
 * Ownership: a session is owned by `session.node_id`, the node that created it (the Desk's node at knock time) or
 * adopted it on a resume while the previous owner was lost. The owner holds the live registry entry, the timers and
 * runs every handler for the session. A participant socket held by another node is piped: that node forwards the
 * socket's session-scoped frames to the owner (`in` on `node:<owner>`), the owner handles them against a RemoteConn
 * proxy whose replies go back as `out` / `close` on `node:<holder>`, and the holder reports the socket's end as
 * `closed`. Org / user / token scoped events (knock fan-out, held knocks, revocation, sign-out) go to every node on
 * `cluster`; each node applies them to its own sockets.
 */
import { WS_CLOSE, type SessionState, type SignalOf } from '@indiansassist/shared';
import { findTokenByTid, getDevice, getOrg, getSession, type SessionRow, type TokenRow } from '@indiansassist/db';
import { completeWorkerHello } from '../fleet/worker.js';
import { handleCameraHello } from './camera.js';
import { channels } from '../adapters/presence.js';
import { canActOnToken } from '../lib/rbac.js';
import { principalFromAuthSessionId } from '../plugins/auth.js';
import type { TokenVerifyOk } from '../services/token-verify.js';
import { refreshUserSockets } from './auth-watch.js';
import { Conn, type DeskInfo, type RelayCounters, type Transport } from './conn.js';
import { deskResume } from './desk.js';
import { completeHandover } from './handover-hello.js';
import type { SignalHub } from './hub.js';
import { performHeldKnocks, type KnockUser } from './knock.js';
import { onConnClosed, onSessionEnded, onTokenRevoked } from './lifecycle.js';

export type ConnSnapshot = { id: string; side: 'assist' | 'desk' | 'camera'; ip: string; ua: string | null; authSessionId: string | null; desk: DeskInfo | null };

type TokRef = Pick<TokenRow, 'orgId' | 'createdBy'>;

export type NodeMsg =
  | { k: 'in'; from: string; conn: ConnSnapshot; frame: string }
  // `handover`: Phase C section 7.2 (6), a hand-over hello verified on the holder node, completed by the owner.
  | { k: 'desk-resume'; from: string; conn: ConnSnapshot; tokenId: string; via: TokenVerifyOk['via']; sessionId: string; re?: string; handover?: { opId: string; hash: string } }
  | { k: 'out'; connId: string; frame: string }
  | { k: 'close'; connId: string; code: number; reason: string }
  | { k: 'closed'; connId: string }
  | { k: 'ended'; sessionId: string; previousState: SessionState }
  | { k: 'recording'; sessionId: string }
  | { k: 'rpc'; id: string; from: string; op: 'chatCount' | 'relayCounters'; sessionId: string }
  // Phase D rule 3.6c: an S->D frame for a device socket held by this node, and a disable / retire kick.
  | { k: 'device'; deviceId: string; frame: Record<string, unknown> }
  | { k: 'device-kick'; deviceId: string; code: 'device_disabled' | 'device_unauthenticated'; message: string }
  // Phase D rule 3.6d: a P4 worker hello verified on the holder node, completed by the session's owner.
  | { k: 'worker-hello'; from: string; conn: ConnSnapshot; sessionId: string; gen: number; re?: string }
  // Phase F section 6.4: a phone's first `camera.hello { code }` on a node that does not own the session; the owner
  // consumes the code, so the holder never spends it. Also a `camera.hello { resumeKey }` whose `ia:camres:` record
  // names a session of another node: only the owner checks (and spends) the key.
  | { k: 'camera-hello'; from: string; conn: ConnSnapshot; msg: SignalOf<'camera.hello'> }
  | { k: 'rpc-reply'; id: string; value: unknown };

export type ClusterEvent =
  | { e: 'assists'; tok: TokRef; frame: Record<string, unknown>; except: string | null }
  | { e: 'held-knocks'; user: KnockUser }
  | { e: 'token-revoked'; tokenId: string }
  | { e: 'close-user'; userId: string; code: number; exceptAuthSessionId?: string }
  | { e: 'close-auth'; ids: string[]; code: number }
  | { e: 'refresh-user'; userId: string }
  | { e: 'routed-ended'; sessionId: string; frame: Record<string, unknown> }
  | { e: 'user-frame'; userId: string; frame: Record<string, unknown> };

/** Online-Assist registry TTL and refresh period. */
const ASSIST_TTL_SEC = 90;
const REFRESH_MS = 30_000;
const RPC_TIMEOUT_MS = 1_000;

/** On the owner node: a socket held by node `node`, reached through the bridge. */
export class RemoteConn extends Conn {
  override readonly remote = true;
  constructor(
    readonly node: string,
    snap: ConnSnapshot,
    transport: Transport,
  ) {
    super(transport, snap.ip, snap.ua, null, snap.id);
    this.side = snap.side;
    this.desk = snap.desk ? { ...snap.desk } : null;
  }
}

export class Bridge {
  readonly on: boolean;
  readonly self: string;
  readonly remotes = new Map<string, RemoteConn>();
  private readonly unsubs: (() => Promise<void>)[] = [];
  private readonly pending = new Map<string, (value: unknown) => void>();
  private rpcSeq = 0;
  private lastRefresh = Date.now();

  constructor(private readonly hub: SignalHub) {
    this.on = hub.ctx.presence.multiNode;
    this.self = hub.ctx.config.nodeId;
  }

  async start(): Promise<void> {
    if (!this.on) return;
    const p = this.hub.ctx.presence;
    this.unsubs.push(await p.subscribe(channels.cluster, (m) => this.run('cluster', () => this.onCluster(m as ClusterEvent & { origin: string }))));
    this.unsubs.push(await p.subscribe(channels.node(this.self), (m) => this.run('node', () => this.onNode(m as NodeMsg))));
  }

  async stop(): Promise<void> {
    for (const u of this.unsubs.splice(0)) await u().catch(() => undefined);
    for (const rc of this.remotes.values()) rc.closed = rc.terminated = true;
    this.remotes.clear();
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }

  private run(where: string, fn: () => void | Promise<void>): void {
    try {
      const r = fn();
      if (r) r.catch((err: unknown) => this.hub.ctx.log.error({ err, where }, 'bridge handler failed'));
    } catch (err) {
      this.hub.ctx.log.error({ err, where }, 'bridge handler failed');
    }
  }

  private publish(channel: string, msg: object): void {
    this.hub.ctx.presence.publish(channel, msg).catch((err: unknown) => this.hub.ctx.log.warn({ err, channel }, 'bridge publish failed'));
  }

  toNode(node: string, msg: NodeMsg): void {
    if (this.on) this.publish(channels.node(node), msg);
  }

  /** To every other node (the caller applies the event locally itself). */
  broadcast(ev: ClusterEvent): void {
    if (this.on) this.publish(channels.cluster, { ...ev, origin: this.self });
  }

  private alive(nodeId: string): Promise<boolean> {
    return this.hub.ctx.presence.isNodeAlive(nodeId);
  }

  // ---------- holder side: local sockets ----------

  /** The owner node a frame of this local socket must be forwarded to, or null to handle it here. */
  async ownerFor(conn: Conn, sessionId: string | undefined): Promise<string | null> {
    if (!this.on || conn.remote) return null;
    if (conn.side === 'desk' || conn.side === 'camera') return conn.pipeTo;
    if (conn.side !== 'assist' || !sessionId || this.hub.live.has(sessionId)) return null;
    const cached = conn.routes.get(sessionId);
    if (cached) return cached;
    const s = await getSession(this.hub.ctx.db, sessionId);
    // A session of a lost owner is handled here: a resume adopts it (node_id := this node), anything else is refused.
    if (!s || s.nodeId === this.self || !(await this.alive(s.nodeId))) return null;
    conn.route(sessionId, s.nodeId);
    return s.nodeId;
  }

  forward(node: string, conn: Conn, frame: string): void {
    conn.pipes.add(node);
    this.toNode(node, { k: 'in', from: this.self, conn: snapshot(conn), frame });
  }

  /** A Desk resuming a session owned by another live node is piped there; true when forwarded. */
  async forwardDeskResume(conn: Conn, v: TokenVerifyOk, re: string | undefined): Promise<boolean> {
    return v.resumeSession ? this.pipeDesk(conn, v, v.resumeSession, re) : false;
  }

  /** Phase C section 7.2 (6): a hand-over hello for a session owned by another live node is completed there. */
  async forwardDeskHandover(conn: Conn, v: TokenVerifyOk, s: SessionRow, opId: string, hash: string, re: string | undefined): Promise<boolean> {
    return this.pipeDesk(conn, v, s, re, { opId, hash });
  }

  /** Phase D rule 3.6d: a worker hello for a session owned by another live node is completed there. */
  async forwardWorkerHello(conn: Conn, s: SessionRow, gen: number, re: string | undefined): Promise<boolean> {
    if (!this.on || !conn.desk || s.nodeId === this.self || !(await this.alive(s.nodeId))) return false;
    conn.pipeTo = s.nodeId;
    conn.pipes.add(s.nodeId);
    conn.desk.sessionId = s.id;
    this.toNode(s.nodeId, { k: 'worker-hello', from: this.self, conn: snapshot(conn), sessionId: s.id, gen, ...(re !== undefined ? { re } : {}) });
    return true;
  }

  /**
   * Phase F section 6.4: a phone whose code (or resume key) names a session owned by another live node is piped
   * there, as a Desk is; the owner checks, spends and answers. True when forwarded.
   */
  async forwardCameraHello(conn: Conn, s: Pick<SessionRow, 'id' | 'nodeId'>, msg: SignalOf<'camera.hello'>): Promise<boolean> {
    if (!this.on || conn.remote || s.nodeId === this.self || !(await this.alive(s.nodeId))) return false;
    conn.side = 'camera';
    conn.pipeTo = s.nodeId;
    conn.pipes.add(s.nodeId);
    conn.route(s.id, s.nodeId);
    this.toNode(s.nodeId, { k: 'camera-hello', from: this.self, conn: snapshot(conn), msg });
    return true;
  }

  private async pipeDesk(conn: Conn, v: TokenVerifyOk, s: SessionRow, re: string | undefined, handover?: { opId: string; hash: string }): Promise<boolean> {
    if (!this.on || !conn.desk || s.nodeId === this.self || !(await this.alive(s.nodeId))) return false;
    conn.pipeTo = s.nodeId;
    conn.pipes.add(s.nodeId);
    const snap = snapshot(conn);
    conn.desk.sessionId = s.id;
    const extra = { ...(re !== undefined ? { re } : {}), ...(handover ? { handover } : {}) };
    this.toNode(s.nodeId, { k: 'desk-resume', from: this.self, conn: snap, tokenId: v.token.id, via: v.via, sessionId: s.id, ...extra });
    return true;
  }

  /** A local socket closed: its owners learn `closed`, its Assist registry entry goes. */
  socketClosed(conn: Conn): void {
    if (!this.on) return;
    for (const n of conn.pipes) this.toNode(n, { k: 'closed', connId: conn.id });
    const p = conn.principal;
    if (conn.side === 'assist' && p)
      this.hub.ctx.presence.clearAssistOnline(p.org.id, conn.id).catch((err: unknown) => this.hub.ctx.log.warn({ err }, 'assist registry clear failed'));
  }

  async assistOnline(conn: Conn): Promise<void> {
    const p = conn.principal;
    if (!this.on || !p || conn.side !== 'assist' || conn.closed) return;
    await this.hub.ctx.presence.setAssistOnline(
      { connectionId: conn.id, userId: p.user.id, orgId: p.org.id, role: p.user.role, nodeId: this.self },
      ASSIST_TTL_SEC,
    );
  }

  /** An Assist on another live node may act on the token (section 7.5 "eligible Assist online"). */
  async remoteAssistFor(tok: TokRef): Promise<boolean> {
    if (!this.on) return false;
    const alive = new Map<string, boolean>();
    for (const a of await this.hub.ctx.presence.listAssistsOnline(tok.orgId)) {
      if (a.nodeId === this.self || !canActOnToken({ id: a.userId, orgId: a.orgId, role: a.role }, tok)) continue;
      if (!alive.has(a.nodeId)) alive.set(a.nodeId, await this.alive(a.nodeId));
      if (alive.get(a.nodeId)) return true;
    }
    return false;
  }

  /** The relay count of a session owned by another node (for `chat.relayed` when it is ended here). */
  async chatCount(sessionId: string): Promise<number> {
    const v = await this.rpc(sessionId, 'chatCount');
    return typeof v === 'number' ? v : 0;
  }

  /** The WS relay counters of a session owned by another node (for `mirror.relayed`, Phase B 4.6). */
  async relayCounters(sessionId: string): Promise<RelayCounters | null> {
    const v = await this.rpc(sessionId, 'relayCounters');
    return v && typeof v === 'object' ? (v as RelayCounters) : null;
  }

  private async rpc(sessionId: string, op: 'chatCount' | 'relayCounters'): Promise<unknown> {
    if (!this.on) return null;
    const s = await getSession(this.hub.ctx.db, sessionId);
    if (!s || s.nodeId === this.self || !(await this.alive(s.nodeId))) return null;
    const id = `${this.self}:${++this.rpcSeq}`;
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.toNode(s.nodeId, { k: 'rpc', id, from: this.self, op, sessionId });
    });
  }

  /** A session ended without a live entry here: tell the local sockets piped to it (its owner is gone). */
  endedWithoutOwner(sessionId: string, frame: Record<string, unknown>): void {
    this.deliverRoutedEnd(sessionId, frame);
    this.broadcast({ e: 'routed-ended', sessionId, frame });
  }

  private deliverRoutedEnd(sessionId: string, frame: Record<string, unknown>): void {
    for (const c of this.hub.conns.values()) {
      if (c.closed) continue;
      if (c.side === 'assist' && c.routes.delete(sessionId)) c.send(frame);
      else if (c.side === 'desk' && c.pipeTo && c.desk?.sessionId === sessionId) {
        c.send(frame);
        c.close(WS_CLOSE.sessionEnded, 'session ended');
      } else if (c.side === 'camera' && c.pipeTo && c.routes.has(sessionId)) {
        c.send({ t: 'camera.closed', reason: 'session_ended' });
        c.close(WS_CLOSE.normal, 'camera ended');
      }
    }
  }

  /** Hub tick: refreshes the Assist registry and drops RemoteConns of lost nodes (their sockets are gone). */
  tick(now: number): void {
    if (!this.on || now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    for (const c of this.hub.assistConns())
      this.assistOnline(c).catch((err: unknown) => this.hub.ctx.log.warn({ err }, 'assist registry refresh failed'));
    const nodes = new Set([...this.remotes.values()].map((rc) => rc.node));
    for (const n of nodes) {
      this.alive(n)
        .then((ok) => {
          if (ok) return;
          for (const rc of [...this.remotes.values()]) if (rc.node === n) this.remoteClosed(rc.id);
        })
        .catch((err: unknown) => this.hub.ctx.log.warn({ err }, 'node liveness check failed'));
    }
  }

  // ---------- owner side ----------

  private transportTo(node: string, connId: string): Transport {
    return {
      isOpen: () => true,
      send: (frame) => this.toNode(node, { k: 'out', connId, frame }),
      close: (code, reason) => this.toNode(node, { k: 'close', connId, code, reason }),
      terminate: () => this.toNode(node, { k: 'close', connId, code: 1001, reason: 'terminated' }),
    };
  }

  private remoteFor(from: string, snap: ConnSnapshot): RemoteConn {
    const known = this.remotes.get(snap.id);
    if (known && known.node === from) return known;
    const rc = new RemoteConn(from, snap, this.transportTo(from, snap.id));
    this.remotes.set(rc.id, rc);
    const authId = snap.authSessionId;
    if (snap.side === 'assist' && authId) {
      rc.queue = rc.queue.then(async () => {
        const p = await principalFromAuthSessionId(this.hub.ctx, authId);
        if (!p) {
          rc.error('not_authenticated', 'your sign-in is no longer valid');
          return rc.close(WS_CLOSE.unauthenticated, 'session revoked');
        }
        rc.principal = p;
        rc.lastAuthCheckAt = Date.now();
      });
    } else if (snap.side === 'assist') {
      rc.close(WS_CLOSE.unauthenticated, 'unauthenticated');
    }
    return rc;
  }

  private enqueue(rc: RemoteConn, fn: () => Promise<void>): void {
    rc.queue = rc.queue.then(fn).catch((err: unknown) => this.hub.ctx.log.error({ err, connectionId: rc.id }, 'bridged frame failed'));
  }

  private remoteClosed(connId: string): void {
    const rc = this.remotes.get(connId);
    if (!rc) return;
    this.remotes.delete(connId);
    rc.closed = true;
    this.enqueue(rc, () => onConnClosed(this.hub, rc));
  }

  private onNode(m: NodeMsg): void | Promise<void> {
    const hub = this.hub;
    switch (m.k) {
      case 'in': {
        const rc = this.remoteFor(m.from, m.conn);
        return this.enqueue(rc, () => hub.dispatch(rc, m.frame));
      }
      case 'desk-resume': {
        const rc = this.remoteFor(m.from, m.conn);
        return this.enqueue(rc, () => this.resumeDesk(rc, m));
      }
      case 'out':
        return hub.localConn(m.connId)?.sendRaw(m.frame);
      case 'close':
        return hub.localConn(m.connId)?.close(m.code, m.reason);
      case 'closed':
        return this.remoteClosed(m.connId);
      case 'ended':
        return this.endedHere(m.sessionId, m.previousState);
      case 'recording':
        return hub.pushRecordingLocal(m.sessionId);
      case 'rpc':
        return this.toNode(m.from, {
          k: 'rpc-reply',
          id: m.id,
          value: m.op === 'chatCount' ? (hub.live.get(m.sessionId)?.chatCount ?? 0) : (hub.live.get(m.sessionId)?.relay ?? null),
        });
      case 'rpc-reply':
        this.pending.get(m.id)?.(m.value);
        this.pending.delete(m.id);
        return;
      case 'device':
        hub.devices.deliverLocal(m.deviceId, m.frame);
        return;
      case 'device-kick':
        hub.devices.kickLocal(m.deviceId, m.code, m.message);
        return;
      case 'worker-hello': {
        const rc = this.remoteFor(m.from, m.conn);
        return this.enqueue(rc, () => this.workerHello(rc, m));
      }
      case 'camera-hello': {
        const rc = this.remoteFor(m.from, m.conn);
        return this.enqueue(rc, () => this.cameraHello(rc, m));
      }
    }
  }

  /** The phone's node found this node the owner by the code or the resume key (section 6.4); the hello runs here. */
  private async cameraHello(rc: RemoteConn, m: Extract<NodeMsg, { k: 'camera-hello' }>): Promise<void> {
    try {
      await handleCameraHello(this.hub, rc, m.msg);
    } catch (err) {
      this.hub.helloFailed(rc, err, m.msg.id);
    }
  }

  /** The Desk's node verified the resumeKey (section 3.5); the owner loads the rows and runs the resume. */
  private async resumeDesk(rc: RemoteConn, m: Extract<NodeMsg, { k: 'desk-resume' }>): Promise<void> {
    const { db } = this.hub.ctx;
    try {
      const [token, s] = await Promise.all([findTokenByTid(db, m.tokenId), getSession(db, m.sessionId)]);
      const org = token ? await getOrg(db, token.orgId) : null;
      if (!token || !org || !s || s.tokenId !== token.id || s.state === 'ended')
        throw Object.assign(new Error('resume target gone'), { code: 'already_ended' });
      if (m.handover) return await completeHandover(this.hub, rc, { token, org, session: s }, m.handover.opId, m.handover.hash, m.re);
      await deskResume(this.hub, rc, { ok: true, token, org, via: m.via, resumeSession: s }, m.re);
    } catch (err) {
      this.hub.helloFailed(rc, err, m.re);
    }
  }

  private async workerHello(rc: RemoteConn, m: Extract<NodeMsg, { k: 'worker-hello' }>): Promise<void> {
    const { db } = this.hub.ctx;
    try {
      const s = await getSession(db, m.sessionId);
      const d = s?.deviceId ? await getDevice(db, s.deviceId) : null;
      const org = d ? await getOrg(db, d.orgId) : null;
      if (!s || !d || !org || s.state === 'ended') throw Object.assign(new Error('worker target gone'), { code: 'already_ended' });
      await completeWorkerHello(this.hub, rc, { session: s, device: d, org }, m.gen, m.re);
    } catch (err) {
      this.hub.helloFailed(rc, err, m.re);
    }
  }

  private async endedHere(sessionId: string, previousState: SessionState): Promise<void> {
    const { db } = this.hub.ctx;
    const s = await getSession(db, sessionId);
    const org = s ? await getOrg(db, s.orgId) : null;
    if (s && org) await onSessionEnded(this.hub, { session: s, previousState, org });
  }

  private async onCluster(ev: ClusterEvent & { origin: string }): Promise<void> {
    if (!ev || typeof ev !== 'object' || ev.origin === this.self) return;
    const hub = this.hub;
    switch (ev.e) {
      case 'assists':
        return hub.deliverToAssists(ev.tok, ev.frame, ev.except);
      case 'held-knocks':
        return performHeldKnocks(hub, ev.user);
      case 'token-revoked':
        return onTokenRevoked(hub, ev.tokenId);
      case 'close-user':
        return hub.closeUserSocketsLocal(ev.userId, ev.code, ev.exceptAuthSessionId);
      case 'close-auth':
        return hub.closeSocketsForAuthSessionsLocal(ev.ids, ev.code);
      case 'refresh-user':
        return refreshUserSockets(hub, ev.userId);
      case 'routed-ended':
        return this.deliverRoutedEnd(ev.sessionId, ev.frame);
      case 'user-frame':
        return hub.toUserLocal(ev.userId, ev.frame);
    }
  }
}

function snapshot(conn: Conn): ConnSnapshot {
  return {
    id: conn.id,
    side: conn.side === 'assist' ? 'assist' : conn.side === 'camera' ? 'camera' : 'desk',
    ip: conn.ip,
    ua: conn.userAgent,
    authSessionId: conn.principal?.authSession.id ?? null,
    desk: conn.desk ? { ...conn.desk } : null,
  };
}
