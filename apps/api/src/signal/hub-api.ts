/**
 * The part of the signaling hub that REST routes and services call (`ctx.hub.*`). Each call may run on any api node:
 * session-scoped calls are routed to the session's owner node, user / token scoped ones are applied here and fanned
 * out to every other node through the bridge (contracts section 7.6 N1).
 */
import { getSession } from '@indiansassist/db';
import type { AppContext } from '../context.js';
import type { EndedSession } from '../services/session-end.js';
import { refreshUserSockets } from './auth-watch.js';
import type { Bridge } from './bridge.js';
import type { Conn, Live } from './conn.js';
import type { SignalHub } from './hub.js';
import { onSessionEnded, onTokenRevoked } from './lifecycle.js';

export abstract class HubApi {
  abstract readonly ctx: AppContext;
  abstract readonly conns: Map<string, Conn>;
  abstract readonly live: Map<string, Live>;
  abstract readonly bridge: Bridge;
  abstract conn(id: string | null | undefined): Conn | null;

  private get hub(): SignalHub {
    return this as unknown as SignalHub;
  }

  /** Relayed chat messages of a session (for `chat.relayed`), asked of the owner node when it is elsewhere. */
  async chatCount(sessionId: string): Promise<number> {
    const live = this.live.get(sessionId);
    return live ? live.chatCount : this.bridge.chatCount(sessionId);
  }

  /** After a committed end: the owner node pushes `session.ended` and applies the socket rules (section 7.3). */
  async sessionEnded(ended: EndedSession): Promise<void> {
    const s = ended.session;
    const elsewhere = !this.live.has(s.id) && this.bridge.on && s.nodeId !== this.ctx.config.nodeId;
    if (elsewhere && (await this.ctx.presence.isNodeAlive(s.nodeId))) {
      this.bridge.toNode(s.nodeId, { k: 'ended', sessionId: s.id, previousState: ended.previousState });
      return;
    }
    await onSessionEnded(this.hub, ended);
  }

  tokenRevoked(tokenId: string): void {
    onTokenRevoked(this.hub, tokenId);
    this.bridge.broadcast({ e: 'token-revoked', tokenId });
  }

  /** Pushes `session.recording { recording: true }` to the Desk of a session (section 6.8), via its owner. */
  async pushRecording(sessionId: string): Promise<void> {
    if (this.live.has(sessionId) || !this.bridge.on) return this.pushRecordingLocal(sessionId);
    const s = await getSession(this.ctx.db, sessionId);
    if (s && s.nodeId !== this.ctx.config.nodeId) this.bridge.toNode(s.nodeId, { k: 'recording', sessionId });
  }

  pushRecordingLocal(sessionId: string): void {
    const live = this.live.get(sessionId);
    this.conn(live?.deskConnId)?.send({ t: 'session.recording', sessionId, recording: true });
  }

  /**
   * Closes every authenticated socket of a user on every node (disabled mid-session, password change: 4401),
   * optionally keeping the sockets opened with one cookie session (the one that changed the password).
   */
  closeUserSockets(userId: string, code: number, opts: { exceptAuthSessionId?: string } = {}): void {
    this.closeUserSocketsLocal(userId, code, opts.exceptAuthSessionId);
    this.bridge.broadcast({ e: 'close-user', userId, code, ...opts });
  }

  closeUserSocketsLocal(userId: string, code: number, exceptAuthSessionId?: string): void {
    for (const c of [...this.conns.values()]) {
      const p = c.principal;
      if (!p || p.user.id !== userId || c.closed) continue;
      if (exceptAuthSessionId !== undefined && p.authSession.id === exceptAuthSessionId) continue;
      c.error('not_authenticated', 'your sign-in is no longer valid');
      c.close(code, 'signed out');
    }
  }

  /** Closes the sockets opened with the given cookie sessions on every node (logout: 4401). */
  closeSocketsForAuthSessions(authSessionIds: readonly string[], code: number): void {
    this.closeSocketsForAuthSessionsLocal(authSessionIds, code);
    this.bridge.broadcast({ e: 'close-auth', ids: [...authSessionIds], code });
  }

  closeSocketsForAuthSessionsLocal(authSessionIds: readonly string[], code: number): void {
    const ids = new Set(authSessionIds);
    for (const c of [...this.conns.values()]) {
      if (!c.principal || c.closed || !ids.has(c.principal.authSession.id)) continue;
      c.error('not_authenticated', 'you signed out');
      c.close(code, 'signed out');
    }
  }

  /** Re-reads the principal of every socket of a user now (this node before the reply; other nodes on receipt). */
  async refreshUser(userId: string): Promise<void> {
    this.bridge.broadcast({ e: 'refresh-user', userId });
    await refreshUserSockets(this.hub, userId);
  }
}
