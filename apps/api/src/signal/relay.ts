/**
 * Session authorisation and relays (contracts sections 7.2-7.4).
 * Every message carrying `sessionId` is accepted only from the connection currently registered as that session's
 * `assist` or `desk` participant; anything else gets `error forbidden` (and `signal.forbidden` in the chain when the
 * sender is an authenticated Assist). Hard rule 1: `webrtc.*` is relayed only while the session is `active`.
 */
import { WS_CLOSE, type SignalOf } from '@indiansassist/shared';
import { getOrg, getSession } from '@indiansassist/db';
import { deskActor, userActor, writeAudit } from '../lib/audit.js';
import { endSessionFlow } from '../services/session-end.js';
import type { Conn, Live } from './conn.js';
import { forbiddenKey } from './forbidden.js';
import type { SignalHub } from './hub.js';

/** The live entry when `conn` is the registered participant of `sessionId`; otherwise replies forbidden. */
export async function authorizeSession(
  hub: SignalHub,
  conn: Conn,
  sessionId: string,
  messageType: string,
  re?: string,
): Promise<Live | null> {
  const live = hub.live.get(sessionId);
  const registered = conn.side === 'assist' ? live?.assistConnId : live?.deskConnId;
  if (live && registered === conn.id) return live;
  await refuse(hub, conn, sessionId, messageType, re);
  return null;
}

/**
 * `error forbidden`, a warn log line and, for an authenticated Assist, `signal.forbidden` (sections 5.3, 6.12, 7.2).
 * Entries and the flood close are budgeted per principal (user / Desk token) on the hub, not per socket, so random
 * session ids and reconnect loops cannot multiply rows (SEC-05, forbidden.ts).
 */
export async function refuse(
  hub: SignalHub,
  conn: Conn,
  sessionId: string | null,
  messageType: string,
  re?: string,
): Promise<void> {
  const { ctx } = hub;
  conn.error('forbidden', 'not a participant of this session', re);
  const key = forbiddenKey(conn);
  const d = hub.forbidden.record(key, sessionId);
  if (d.flood) {
    ctx.log.warn({ connectionId: conn.id, side: conn.side, principal: key, recent: d.recent }, 'signal forbidden flood; closing');
    conn.close(WS_CLOSE.forbidden, 'too many forbidden frames');
    return;
  }
  if (!d.write) return;
  ctx.log.warn({ connectionId: conn.id, sessionId, messageType, side: conn.side, suppressed: d.suppressed }, 'signal forbidden');
  const p = conn.principal;
  if (conn.side !== 'assist' || !p) return;
  const s = sessionId ? await getSession(ctx.db, sessionId) : null;
  const org = (await getOrg(ctx.db, p.org.id)) ?? p.org;
  await writeAudit(ctx, ctx.db, org, {
    sessionId: s && s.orgId === org.id ? s.id : null,
    actor: userActor(p.user),
    action: 'signal.forbidden',
    data: { connectionId: conn.id, messageType, sessionId, ...(d.suppressed > 0 ? { suppressed: d.suppressed } : {}) },
  });
}

function peerOf(hub: SignalHub, conn: Conn, live: Live): Conn | null {
  return hub.conn(conn.side === 'assist' ? live.deskConnId : live.assistConnId);
}

type WebrtcMsg = SignalOf<'webrtc.offer'> | SignalOf<'webrtc.answer'> | SignalOf<'webrtc.ice'>;

export async function handleWebrtc(hub: SignalHub, conn: Conn, msg: WebrtcMsg): Promise<void> {
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  if (live.state !== 'active')
    return conn.error('consent_required', 'media is relayed only after accept and consent', msg.id);
  peerOf(hub, conn, live)?.sendRaw(JSON.stringify(msg));
}

export async function handleChatMessage(hub: SignalHub, conn: Conn, msg: SignalOf<'chat.message'>): Promise<void> {
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  if (live.state !== 'active') return conn.error('consent_required', 'chat relay needs an active session', msg.id);
  if (live.chatClosed) return conn.error('relay_closed', 'chat now flows over the data channel', msg.id);
  live.chatCount += 1;
  // `from` is overwritten with the sender's side; the text is never logged or stored.
  peerOf(hub, conn, live)?.send({ ...msg, from: conn.side });
}

export async function handleSessionEnd(hub: SignalHub, conn: Conn, msg: SignalOf<'session.end'>): Promise<void> {
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  const s = await getSession(hub.ctx.db, msg.sessionId);
  if (!s || s.state === 'ended') return conn.error('bad_state', 'session already ended', msg.id);
  const byAssist = conn.side === 'assist';
  await endSessionFlow(hub.ctx, s.id, {
    reason: byAssist ? 'assist_ended' : 'desk_stopped',
    actor: byAssist ? userActor(conn.principal!.user) : deskActor(s.deskRef),
    note: msg.note ?? null,
  });
}
