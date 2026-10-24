/**
 * Assist-side signaling handlers (contracts sections 7.2-7.5): `assist.hello` (knock replay and held knocks),
 * `assist.accept`, `assist.deny` (with auto-revoke after three consecutive denials), `assist.resume`,
 * `session.stats` and `chat.channel_open`.
 */
import { LIMITS, WS_CLOSE, type SignalOf } from '@indiansassist/shared';
import {
  addParticipant,
  findTokenByTid,
  getSession,
  incrementTokenDenied,
  lockSession,
  replaceParticipant,
  SessionAlreadyEndedError,
  resetTokenDenied,
  session as sessionTable,
  transitionSession,
  updateSession,
} from '@indiansassist/db';
import { and, eq } from 'drizzle-orm';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { canActOnToken, hasRole, TECH_ROLES } from '../lib/rbac.js';
import { endSessionFlow } from '../services/session-end.js';
import { afterTokenRevoked, revokeTokenRow } from '../services/token-revoke.js';
import { clearTimer, type Conn } from './conn.js';
import { forbiddenKey } from './forbidden.js';
import { performHeldKnocks } from './knock.js';
import type { SignalHub } from './hub.js';
import { cancelGrace, startAssistGrace } from './lifecycle.js';
import {
  assistKnockMsg,
  deskIce,
  ensureLive,
  orgOf,
  policyOf,
  scheduleIceRefresh,
  sessionCreatedMsg,
  startConsentTimer,
} from './messages.js';
import { authorizeSession, refuse } from './relay.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

/** Minimum spacing of `session.path_changed` entries for one session. */
export const PATH_CHANGE_MIN_MS = 30_000;

export async function handleAssistHello(hub: SignalHub, conn: Conn, msg: SignalOf<'assist.hello'>): Promise<void> {
  const { ctx } = hub;
  const p = conn.principal;
  if (!p) {
    conn.error('not_authenticated', 'sign in required', msg.id);
    return conn.close(WS_CLOSE.unauthenticated, 'unauthenticated');
  }
  if (!hasRole(p.user.role, TECH_ROLES)) {
    conn.error('forbidden', 'your role cannot connect as Assist', msg.id);
    return conn.close(WS_CLOSE.forbidden, 'forbidden');
  }
  const key = forbiddenKey({ id: conn.id, side: 'assist', principal: p, desk: null });
  if (hub.forbidden.flooding(key)) {
    // SEC-05 cooldown: a user above the forbidden-frame limit cannot reconnect around it.
    const retryAfterSec = hub.forbidden.retryAfterSec(key);
    conn.error('rate_limited', 'too many forbidden frames; try again later', msg.id, { retryAfterSec });
    return conn.close(WS_CLOSE.rateLimited, 'rate limited');
  }
  conn.side = 'assist';
  await hub.bridge.assistOnline(conn).catch((err: unknown) => ctx.log.warn({ err }, 'assist registry write failed'));
  conn.send({
    t: 'assist.hello.ok',
    ...re(msg.id),
    connectionId: conn.id,
    user: { id: p.user.id, name: p.user.name, role: p.user.role },
    region: p.org.dataRegion,
  });
  // Replay every pending knock this socket is subscribed to.
  const knocked = await ctx.db
    .select()
    .from(sessionTable)
    .where(and(eq(sessionTable.orgId, p.org.id), eq(sessionTable.state, 'knocked')));
  for (const s of knocked) {
    const tok = await findTokenByTid(ctx.db, s.tokenId);
    if (!tok || !canActOnToken(p.user, tok)) continue;
    const creator = refOf(await userRefs(ctx.db, [tok.createdBy]), tok.createdBy);
    conn.send(assistKnockMsg(s, tok, creator, true));
  }
  // Perform held knocks on the Desks' behalf (section 7.5), here and on every other node.
  const user = { id: p.user.id, orgId: p.org.id, role: p.user.role };
  hub.bridge.broadcast({ e: 'held-knocks', user });
  await performHeldKnocks(hub, user);
}

/** Loads the session and token for accept / deny, refusing anything outside the "knock accept / deny" row. */
async function knockTarget(hub: SignalHub, conn: Conn, sessionId: string, t: string, reId?: string) {
  const p = conn.principal!;
  const s = await getSession(hub.ctx.db, sessionId);
  const tok = s && s.orgId === p.org.id ? await findTokenByTid(hub.ctx.db, s.tokenId) : null;
  if (!s || !tok || !canActOnToken(p.user, tok)) {
    await refuse(hub, conn, sessionId, t, reId);
    return null;
  }
  if (s.state !== 'knocked') {
    conn.error('bad_state', `session is ${s.state}`, reId);
    return null;
  }
  return { s, tok, p };
}

export async function handleAssistAccept(hub: SignalHub, conn: Conn, msg: SignalOf<'assist.accept'>): Promise<void> {
  const { ctx } = hub;
  const target = await knockTarget(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!target) return;
  const { s, tok, p } = target;
  const org = await orgOf(hub, s.orgId);
  const row = await ctx.db.transaction(async (tx) => {
    // Phase A.2 M1: the org recording policy is snapshotted at accept.
    await transitionSession(tx, s.id, 'accepted', {
      from: 'knocked',
      set: { assistUserId: p.user.id, recordingMode: org.recordingMode },
    });
    await resetTokenDenied(tx, tok.id);
    await writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: userActor(p.user),
      action: 'session.accepted',
      data: { tokenId: tok.id, onBehalfOf: tok.createdBy !== p.user.id ? tok.createdBy : null },
    });
    const r = await transitionSession(tx, s.id, 'consent_pending', {
      from: 'accepted',
      set: { consentDeadlineAt: new Date(Date.now() + ctx.timing.consentTimeoutMs) },
    });
    await addParticipant(tx, { sessionId: s.id, role: 'assist', userId: p.user.id, label: p.user.name, connectionId: conn.id });
    return r;
  });
  const live = ensureLive(hub, row);
  if (row.tier === 'p2_extension') live.policy ??= policyOf(org);
  live.assistConnId = conn.id;
  clearTimer(live, 'knock');
  startConsentTimer(hub, live);
  const assistRef = { id: p.user.id, name: p.user.name };
  conn.send({ ...sessionCreatedMsg(hub, row, org, assistRef, 'assist'), ...re(msg.id) });
  hub.conn(live.deskConnId)?.send(sessionCreatedMsg(hub, row, org, assistRef, 'desk'));
  hub.toAssists(tok, { t: 'knock.closed', sessionId: s.id, by: 'accepted', acceptedBy: assistRef }, conn.id);
  scheduleIceRefresh(hub, live, 'assist');
}

export async function handleAssistDeny(hub: SignalHub, conn: Conn, msg: SignalOf<'assist.deny'>): Promise<void> {
  const { ctx } = hub;
  const target = await knockTarget(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!target) return;
  const { s, tok, p } = target;
  const actor = userActor(p.user);
  const requested = msg.revokeToken === true;
  let denied = 0;
  let revoked = false;
  await endSessionFlow(ctx, s.id, {
    reason: 'denied',
    actor,
    from: ['knocked'],
    before: async (tx, org) => {
      denied = await incrementTokenDenied(tx, tok.id);
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor,
        action: 'session.denied',
        reason: msg.reason ?? null,
        data: { tokenId: tok.id, revokeToken: requested },
      });
    },
    after: async (tx) => {
      if (!requested && denied < LIMITS.autoRevokeDenials) return;
      const res = await revokeTokenRow(ctx, tx, tok.id, requested ? 'manual' : 'auto_denied', requested ? actor : systemActor);
      revoked = res?.changed ?? false;
    },
  });
  if (revoked) await afterTokenRevoked(ctx, tok.id, requested ? actor : systemActor);
}

export async function handleAssistResume(hub: SignalHub, conn: Conn, msg: SignalOf<'assist.resume'>): Promise<void> {
  const { ctx } = hub;
  const p = conn.principal!;
  const s0 = await getSession(ctx.db, msg.sessionId);
  if (!s0 || s0.orgId !== p.org.id || s0.assistUserId !== p.user.id) return refuse(hub, conn, msg.sessionId, msg.t, msg.id);
  if (s0.state !== 'accepted' && s0.state !== 'consent_pending' && s0.state !== 'active')
    return conn.error('bad_state', `session is ${s0.state}`, msg.id);
  const org = await orgOf(hub, s0.orgId);
  // Register and cancel the grace timer before the transaction (correctness-F9); roll back on failure.
  const hadLive = hub.live.has(s0.id);
  const live = ensureLive(hub, s0);
  const previousConnId = live.assistConnId;
  live.assistConnId = conn.id;
  cancelGrace(hub, s0.id, 'assist');
  try {
    await ctx.db.transaction(async (tx) => {
      const locked = await lockSession(tx, s0.id); // session row before its participant rows (lock order, F1)
      if (!locked || locked.state === 'ended') throw new SessionAlreadyEndedError('ended');
      await replaceParticipant(tx, { sessionId: s0.id, role: 'assist', userId: p.user.id, label: p.user.name, connectionId: conn.id });
      await writeAudit(ctx, tx, org, {
        sessionId: s0.id,
        actor: systemActor,
        action: 'session.resumed',
        data: { side: 'assist', fromState: s0.state, toState: s0.state },
      });
      await updateSession(tx, s0.id, { nodeId: ctx.config.nodeId });
    });
  } catch (err) {
    if (live.assistConnId === conn.id) live.assistConnId = hub.conn(previousConnId) ? previousConnId : null;
    const code = (err as { code?: string }).code;
    const ended = code === 'already_ended' || code === 'invalid_transition';
    if (ended && !hadLive) hub.live.delete(s0.id);
    else if (!ended && live.state !== 'ended' && live.assistConnId === null) startAssistGrace(hub, live);
    throw err;
  }
  const s = (await getSession(ctx.db, s0.id))!;
  ensureLive(hub, s);
  conn.send({ ...sessionCreatedMsg(hub, s, org, { id: p.user.id, name: p.user.name }, 'assist'), ...re(msg.id) });
  if (live.recorder.joined) conn.send({ t: 'session.recording', sessionId: s.id, recording: true, source: 'server' });
  scheduleIceRefresh(hub, live, 'assist');
  const desk = hub.conn(live.deskConnId);
  if (desk) {
    desk.send({ t: 'assist.reconnected', sessionId: s.id, state: s.state, ...(s.state === 'active' ? deskIce(hub, s.id) : {}) });
    if (s.state === 'active') scheduleIceRefresh(hub, live, 'desk');
  }
}

export async function handleSessionStats(hub: SignalHub, conn: Conn, msg: SignalOf<'session.stats'>): Promise<void> {
  const { ctx } = hub;
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!live) return;
  const now = Date.now();
  if (now - live.lastStatsAt < 4000) return; // dropped silently (section 6.12)
  live.lastStatsAt = now;
  const s = await getSession(ctx.db, msg.sessionId);
  if (!s || s.state === 'ended') return;
  const lastStats = {
    ...(msg.mirrorKbps !== undefined ? { mirrorKbps: msg.mirrorKbps } : {}),
    ...(msg.mirrorTabs !== undefined ? { mirrorTabs: msg.mirrorTabs } : {}),
    ...(msg.mirrorTransport !== undefined ? { mirrorTransport: msg.mirrorTransport } : {}),
    ...(msg.sessionKbps !== undefined ? { sessionKbps: msg.sessionKbps } : {}),
    path: msg.path,
    rttMs: msg.rttMs,
    codec: msg.codec,
    bitrateKbps: msg.bitrateKbps,
    fps: msg.fps,
    width: msg.width,
    height: msg.height,
    packetsLost: msg.packetsLost,
    ts: msg.ts,
  };
  // `session.path_changed` at most once per PATH_CHANGE_MIN_MS per session (SEC-05): a console flipping `path`
  // every frame cannot flood the chain; a pending change is written by the first frame after the window.
  if (msg.path === s.path || now - live.lastPathChangeAt < PATH_CHANGE_MIN_MS) {
    await updateSession(ctx.db, s.id, { lastStats });
    return;
  }
  live.lastPathChangeAt = now;
  const org = await orgOf(hub, s.orgId);
  await ctx.db.transaction(async (tx) => {
    await updateSession(tx, s.id, { lastStats, path: msg.path });
    await writeAudit(ctx, tx, org, {
      sessionId: s.id,
      actor: systemActor,
      action: 'session.path_changed',
      data: { from: s.path, to: msg.path },
    });
  });
  live.path = msg.path;
}

export async function handleChatChannelOpen(hub: SignalHub, conn: Conn, msg: SignalOf<'chat.channel_open'>): Promise<void> {
  const live = await authorizeSession(hub, conn, msg.sessionId, msg.t, msg.id);
  if (live) live.chatClosed = true;
}
