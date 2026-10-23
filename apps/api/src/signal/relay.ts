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

/** `signal.forbidden` is written at most once per (connection, session) in this window, carrying `suppressed`. */
export const FORBIDDEN_COALESCE_MS = 60_000;
/** More forbidden frames than this within a minute close the socket `4403`. */
export const FORBIDDEN_CLOSE_AFTER = 20;

/**
 * `error forbidden`, a warn log line and, for an authenticated Assist, `signal.forbidden` (sections 5.3, 7.2).
 * The chain entry is coalesced per (connection, session) (SEC-05): the first attempt writes an entry, repeats within
 * FORBIDDEN_COALESCE_MS are counted and reported as `suppressed` on the next entry; a socket that keeps sending
 * forbidden frames is closed `4403`.
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
  const now = Date.now();
  conn.forbiddenTimes = conn.forbiddenTimes.filter((t) => t > now - 60_000);
  conn.forbiddenTimes.push(now);
  const p = conn.principal;
  const key = sessionId ?? '-';
  const prior = conn.forbidden.get(key);
  const coalesced = prior !== undefined && now - prior.writtenAt < FORBIDDEN_COALESCE_MS;
  if (coalesced) prior.suppressed += 1;
  else ctx.log.warn({ connectionId: conn.id, sessionId, messageType, side: conn.side }, 'signal forbidden');
  if (conn.forbiddenTimes.length > FORBIDDEN_CLOSE_AFTER) {
    ctx.log.warn({ connectionId: conn.id, side: conn.side }, 'signal forbidden flood; closing');
    conn.close(WS_CLOSE.forbidden, 'too many forbidden frames');
  }
  if (conn.side !== 'assist' || !p || coalesced) return;
  conn.forbidden.set(key, { writtenAt: now, suppressed: 0 });
  if (conn.forbidden.size > 256) {
    const oldest = conn.forbidden.keys().next().value;
    if (oldest !== undefined) conn.forbidden.delete(oldest);
  }
  const s = sessionId ? await getSession(ctx.db, sessionId) : null;
  const org = (await getOrg(ctx.db, p.org.id)) ?? p.org;
  await writeAudit(ctx, ctx.db, org, {
    sessionId: s && s.orgId === org.id ? s.id : null,
    actor: userActor(p.user),
    action: 'signal.forbidden',
    data: { connectionId: conn.id, messageType, sessionId, ...(prior?.suppressed ? { suppressed: prior.suppressed } : {}) },
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
