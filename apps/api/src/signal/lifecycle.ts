/**
 * Socket loss, session end and token revocation on the signaling side (contracts sections 7.3-7.5):
 * - a Desk or Assist socket that drops out of a live session starts the 30 s resume grace, after which the session
 *   ends `desk_left` (Desk) or `error` (Assist);
 * - every transition to `ended` pushes `session.ended` to both participants, `knock.closed` to the Assist sockets
 *   that saw the knock, and closes the Desk socket `4410` except after `denied` or a timeout before accept.
 */
import { WS_CLOSE, type SessionEndReason } from '@indiansassist/shared';
import { findTokenByTid, InvalidSessionTransitionError } from '@indiansassist/db';
import { systemActor } from '../lib/audit.js';
import { userRefs, refOf } from '../lib/lookup.js';
import { surfaceOf } from '../lib/mappers.js';
import { isoOrNull, iso } from '../lib/time.js';
import { endSessionQuietly, type EndedSession } from '../services/session-end.js';
import { clearTimer, clearTimers, setTimer, type Conn, type Live } from './conn.js';
import { onRecorderClosed, recorderOnEnded } from './recorder.js';
import { onCameraConnClosed } from './camera.js';
import { protectionsReleased } from '../fleet/session-hooks.js';
import type { SignalHub } from './hub.js';

const KNOCK_CLOSED_BY: Partial<Record<SessionEndReason, string>> = {
  denied: 'denied',
  timeout: 'timeout',
  token_revoked: 'revoked',
};

/** Presence entry for a Desk socket waiting on its token (no live session). */
export async function markDeskWaiting(hub: SignalHub, conn: Conn): Promise<void> {
  if (!conn.desk) return;
  await hub.ctx.presence.setTokenWaiting(
    conn.desk.tokenId,
    { connectionId: conn.id, nodeId: hub.ctx.config.nodeId, knockRequested: conn.desk.held },
    90,
  );
}

/** `token.presence` to every Assist socket that may act on the token, on every node (section 7.3). */
export async function notifyTokenPresence(hub: SignalHub, tokenId: string): Promise<void> {
  const tok = await findTokenByTid(hub.ctx.db, tokenId);
  if (!tok) return;
  const waitingDesks = hub.deskConnsForToken(tokenId).filter((c) => c.desk && c.desk.sessionId === null);
  let waiting = waitingDesks.length > 0;
  let held = waitingDesks.some((c) => c.desk!.held);
  if (hub.bridge.on) {
    // A Desk waiting on another node is known through its presence entry.
    const w = (await hub.ctx.presence.getTokenState(tokenId)).waiting;
    waiting ||= w !== null;
    held ||= w?.knockRequested === true;
  }
  hub.toAssists(tok, { t: 'token.presence', tokenId, waiting, held });
}

export async function onConnClosed(hub: SignalHub, conn: Conn): Promise<void> {
  const { ctx } = hub;
  if (conn.side === 'recorder') return onRecorderClosed(hub, conn);
  if (conn.side === 'camera') return onCameraConnClosed(hub, conn);
  if (conn.side === 'desk' && conn.desk) {
    const sid = conn.desk.sessionId;
    const workerOnly = Boolean(conn.desk.deviceId);
    const live = sid ? hub.live.get(sid) : undefined;
    if (live && live.state !== 'ended' && live.deskConnId === conn.id) {
      live.deskConnId = null;
      // Phase D rule 5.4d: the worker died with input lock / privacy screen on; the OS released them with it.
      if (live.p4) await protectionsReleased(hub, live);
      startDeskGrace(hub, live);
    } else if (!sid && !workerOnly) {
      await ctx.presence.clearTokenWaiting(conn.desk.tokenId, conn.id);
      await notifyTokenPresence(hub, conn.desk.tokenId);
    }
    return;
  }
  if (conn.side === 'assist') {
    for (const live of hub.live.values()) {
      if (live.state === 'ended' || live.assistConnId !== conn.id) continue;
      live.assistConnId = null;
      startAssistGrace(hub, live);
    }
  }
}

/** 30 s for the Desk to resume, then `ended (desk_left)` (section 7.5). */
export function startDeskGrace(hub: SignalHub, live: Live): void {
  setTimer(live, 'desk-grace', hub.ctx.timing.graceMs, () => graceEnd(hub, live, 'desk'));
}

/** 30 s for the Assist to resume, then `ended (error)` (section 7.5). */
export function startAssistGrace(hub: SignalHub, live: Live): void {
  setTimer(live, 'assist-grace', hub.ctx.timing.graceMs, () => graceEnd(hub, live, 'assist'));
}

/**
 * Ends a session whose participant did not come back. The attachment is checked again INSIDE the end transaction,
 * after the session row is locked (correctness-F9): a resume registers its socket before its own transaction, so if
 * a resume started while this end was waiting for the row, the end rolls back (swallowed as a lost race).
 */
function graceEnd(hub: SignalHub, live: Live, side: 'assist' | 'desk'): void {
  const { ctx } = hub;
  const attached = () => (side === 'desk' ? live.deskConnId : live.assistConnId) !== null;
  if (attached()) return;
  void endSessionQuietly(ctx, live.id, {
    reason: side === 'desk' ? 'desk_left' : 'error',
    actor: systemActor,
    before: async (_tx, _org, current) => {
      if (attached()) throw new InvalidSessionTransitionError(current.state, 'ended', 'participant resumed');
    },
  }).catch((err: unknown) => ctx.log.error({ err, sessionId: live.id }, `${side} grace end failed`));
}

/** The `session.ended` frame of an ended session (also re-sent on a repeated `session.end`, W21). */
export async function sessionEndedFrame(hub: SignalHub, s: EndedSession['session']): Promise<Record<string, unknown>> {
  const names = await userRefs(hub.ctx.db, [s.assistUserId]);
  return {
    t: 'session.ended',
    sessionId: s.id,
    endReason: s.endReason ?? 'error',
    endedAt: iso(s.endedAt ?? new Date()),
    startedAt: isoOrNull(s.startedAt),
    durationMs: s.startedAt && s.endedAt ? Math.max(0, s.endedAt.getTime() - s.startedAt.getTime()) : null,
    hashChainTail: s.hashChainTail ?? null,
    assist: refOf(names, s.assistUserId),
    surface: surfaceOf(s),
    recordingStarted: s.recordingStarted,
    reachedActive: s.startedAt !== null,
    serverRecording: s.serverRecording,
  };
}

export async function onSessionEnded(hub: SignalHub, ended: EndedSession): Promise<void> {
  const { ctx } = hub;
  const s = ended.session;
  const reason = s.endReason ?? 'error';
  const live = hub.live.get(s.id);
  if (ended.previousState === 'active') ctx.metrics.sessionsActive.dec();
  if (live) {
    live.state = 'ended';
    clearTimers(live);
    setTimer(live, 'evict', ctx.timing.eventGraceMs, () => hub.live.delete(s.id));
  }
  if (s.tokenId) await ctx.presence.setTokenSession(s.tokenId, null);
  const names = await userRefs(ctx.db, [s.assistUserId]);
  const msg = {
    t: 'session.ended',
    sessionId: s.id,
    endReason: reason,
    endedAt: iso(s.endedAt ?? new Date()),
    startedAt: isoOrNull(s.startedAt),
    durationMs: s.startedAt && s.endedAt ? Math.max(0, s.endedAt.getTime() - s.startedAt.getTime()) : null,
    hashChainTail: s.hashChainTail ?? null,
    assist: refOf(names, s.assistUserId),
    surface: surfaceOf(s),
    recordingStarted: s.recordingStarted,
    reachedActive: s.startedAt !== null,
    serverRecording: s.serverRecording,
  };
  const desk = hub.conn(live?.deskConnId);
  const assist = hub.conn(live?.assistConnId);
  desk?.send(msg);
  assist?.send(msg);
  if (live) await recorderOnEnded(hub, live, msg);
  // No live entry here: the sockets of this session (if any) are piped from nodes whose owner is gone.
  if (!live) hub.bridge.endedWithoutOwner(s.id, msg);
  if (ended.previousState === 'knocked' && s.tokenId) {
    const tok = await findTokenByTid(ctx.db, s.tokenId);
    if (tok) {
      const closed = { t: 'knock.closed', sessionId: s.id, by: KNOCK_CLOSED_BY[reason] ?? 'ended' };
      hub.toAssists(tok, closed, live?.assistConnId ?? null);
    }
  }
  if (desk?.desk) {
    const keepOpen = reason === 'denied' || (reason === 'timeout' && ended.previousState === 'knocked');
    if (keepOpen) {
      desk.desk.sessionId = null;
      desk.desk.held = false;
      await markDeskWaiting(hub, desk);
    } else {
      desk.close(WS_CLOSE.sessionEnded, 'session ended');
    }
  }
}

/** Desk sockets on a revoked token (local, piped or bridged here) learn `token_gone` and are closed `4403`. */
export function onTokenRevoked(hub: SignalHub, tokenId: string): void {
  for (const c of hub.deskConnsForToken(tokenId, { includePiped: true })) {
    c.error('token_gone', 'token was revoked', undefined, { status: 'revoked' });
    c.close(WS_CLOSE.forbidden, 'token revoked');
  }
}

export function cancelGrace(hub: SignalHub, sessionId: string, side: 'assist' | 'desk'): void {
  const live = hub.live.get(sessionId);
  if (live) clearTimer(live, `${side}-grace`);
}
