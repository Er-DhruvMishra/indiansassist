/**
 * Desk-side signaling handlers (contracts sections 7.2, 7.3, 7.5): `desk.hello` (section 3.5 verification, resume),
 * `desk.poll`, `desk.knock` (held knocks when no technician can act) and `desk.consent`. The knock itself lives in
 * knock.ts and `desk.event` in desk-events.ts.
 */
import { WS_CLOSE, type SignalErrorCode, type SignalOf } from '@indiansassist/shared';
import {
  findOpenSessionByToken,
  findTokenByTid,
  getSession,
  markTokenUsed,
  replaceParticipant,
  transitionSession,
  updateSession,
} from '@indiansassist/db';
import { deskActor, systemActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { brandingPublic, effectiveStatus } from '../lib/mappers.js';
import { endSessionFlow } from '../services/session-end.js';
import { verifyTokenInput, type TokenVerifyOk } from '../services/token-verify.js';
import type { Conn } from './conn.js';
import type { SignalHub } from './hub.js';
import { performKnock } from './knock.js';
import { cancelGrace, markDeskWaiting, notifyTokenPresence, startDeskGrace } from './lifecycle.js';
import {
  deskIce,
  deskLabelOf,
  ensureLive,
  orgOf,
  scheduleIceRefresh,
  sessionCreatedMsg,
  startConsentTimer,
  stopConsentTimer,
} from './messages.js';

export { handleDeskEvent } from './desk-events.js';
export { performKnock } from './knock.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

export async function handleDeskHello(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.hello'>): Promise<void> {
  const { ctx } = hub;
  const lim = ctx.limiter.hit(`desk-hello:${conn.ip}`, 30, 60_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    conn.error('rate_limited', 'too many attempts', msg.id, { retryAfterSec: lim.retryAfterSec });
    return conn.close(WS_CLOSE.rateLimited, 'rate limited');
  }
  const v = await verifyTokenInput(ctx, msg.token, msg.resumeKey ? { resumeKey: msg.resumeKey } : {});
  if (!v.ok) {
    conn.error(v.code as SignalErrorCode, v.message, msg.id, v.details);
    return conn.close(v.code === 'rate_limited' ? WS_CLOSE.rateLimited : WS_CLOSE.forbidden, v.code);
  }
  const tok = v.token;
  if (tok.tier !== 'p1_browser' || tok.typ === 'enrollment') {
    conn.error('join_unsupported', 'the client for this package is not available yet', msg.id);
    return conn.close(WS_CLOSE.forbidden, 'join_unsupported');
  }
  conn.side = 'desk';
  conn.desk = {
    tokenId: tok.id,
    orgId: tok.orgId,
    via: v.via,
    helloLabel: msg.deskLabel !== undefined ? deskLabelOf(msg.deskLabel) : null,
    sessionId: null,
    held: false,
    heldLabel: null,
    tokenExpiresAt: tok.expiresAt.getTime(),
  };
  if (v.resumeSession) return deskResume(hub, conn, v, msg.id);
  if (await findOpenSessionByToken(ctx.db, tok.id)) {
    conn.side = null;
    conn.desk = null;
    conn.error('token_busy', 'another Desk is live on this token', msg.id);
    return conn.close(WS_CLOSE.tokenBusy, 'token busy');
  }
  const creator = v.via === 'compact' ? refOf(await userRefs(ctx.db, [tok.createdBy]), tok.createdBy) : null;
  conn.send({
    t: 'desk.hello.ok',
    ...re(msg.id),
    connectionId: conn.id,
    tokenId: tok.id,
    tier: tok.tier,
    technician: creator ? { name: creator.name } : null,
    org: brandingPublic(v.org),
    region: v.org.dataRegion,
  });
  await markDeskWaiting(hub, conn);
  await notifyTokenPresence(hub, tok.id);
}

/**
 * Desk resume with a valid resumeKey (section 7.5 table). The socket is registered and the desk grace timer is
 * cancelled BEFORE the transaction (correctness-F9), so a grace timer that fires while the resume is in flight sees
 * a Desk attached and does nothing; on failure the registration is rolled back (and the grace re-armed if the
 * session is still live) and the error reaches the hub, which answers and closes the socket (correctness-F8).
 */
async function deskResume(hub: SignalHub, conn: Conn, v: TokenVerifyOk, reId: string | undefined): Promise<void> {
  const { ctx } = hub;
  const s0 = v.resumeSession!;
  const wasActive = s0.state === 'active';
  const hadLive = hub.live.has(s0.id);
  const live = ensureLive(hub, s0);
  const previousConnId = live.deskConnId;
  live.deskConnId = conn.id;
  cancelGrace(hub, s0.id, 'desk');
  conn.desk!.sessionId = s0.id;
  try {
    await ctx.db.transaction(async (tx) => {
      await replaceParticipant(tx, { sessionId: s0.id, role: 'desk', label: s0.deskLabel ?? 'Desk', connectionId: conn.id });
      if (wasActive) {
        await transitionSession(tx, s0.id, 'consent_pending', {
          from: 'active',
          set: { consentDeadlineAt: new Date(Date.now() + ctx.timing.consentTimeoutMs) },
        });
      }
      if (s0.state !== 'knocked') {
        await writeAudit(ctx, tx, v.org, {
          sessionId: s0.id,
          actor: systemActor,
          action: 'session.resumed',
          data: { side: 'desk', fromState: s0.state, toState: wasActive ? 'consent_pending' : s0.state },
        });
      }
      await updateSession(tx, s0.id, { nodeId: ctx.config.nodeId });
    });
  } catch (err) {
    if (live.deskConnId === conn.id) live.deskConnId = hub.conn(previousConnId) ? previousConnId : null;
    conn.desk!.sessionId = null;
    const code = (err as { code?: string }).code;
    const ended = code === 'already_ended' || code === 'invalid_transition';
    if (ended && !hadLive) hub.live.delete(s0.id);
    else if (!ended && live.state !== 'ended' && live.deskConnId === null) startDeskGrace(hub, live);
    throw err;
  }
  const s = (await getSession(ctx.db, s0.id))!;
  ensureLive(hub, s);
  const previous = previousConnId !== conn.id ? hub.conn(previousConnId) : null;
  if (previous) {
    previous.desk!.sessionId = null;
    previous.close(WS_CLOSE.tokenBusy, 'replaced by a resumed connection');
  }
  const creator = v.via === 'compact' ? refOf(await userRefs(ctx.db, [v.token.createdBy]), v.token.createdBy) : null;
  conn.send({
    t: 'desk.hello.ok',
    ...re(reId),
    connectionId: conn.id,
    tokenId: v.token.id,
    tier: v.token.tier,
    technician: creator ? { name: creator.name } : null,
    org: brandingPublic(v.org),
    region: v.org.dataRegion,
    resume: { sessionId: s.id, state: s.state, consentState: s.consentState },
  });
  if (s.state === 'knocked') return;
  const assistRef = refOf(await userRefs(ctx.db, [s.assistUserId]), s.assistUserId);
  conn.send(sessionCreatedMsg(hub, s, v.org, assistRef, 'desk'));
  hub.conn(live.assistConnId)?.send({
    t: 'desk.reconnected',
    sessionId: s.id,
    state: s.state,
    consentState: s.consentState,
  });
  if (wasActive) {
    ctx.metrics.sessionsActive.dec();
    startConsentTimer(hub, live);
  }
}

/** Closes a waiting Desk whose token is no longer usable (section 3.5 step 7). */
function tokenGone(conn: Conn, status: string, reId: string | undefined): void {
  conn.error('token_gone', `token is ${status}`, reId, { status });
  conn.close(WS_CLOSE.forbidden, 'token gone');
}

export async function handleDeskPoll(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.poll'>): Promise<void> {
  const d = conn.desk!;
  const tok = await findTokenByTid(hub.ctx.db, d.tokenId);
  const technicianOnline = tok ? hub.assistsForToken(tok).length > 0 : false;
  const live = d.sessionId ? hub.live.get(d.sessionId) : undefined;
  if (live && live.state !== 'ended') {
    const matched = live.state !== 'knocked';
    return conn.send({
      t: 'poll.status',
      ...re(msg.id),
      state: matched ? 'matched' : 'waiting',
      sessionId: live.id,
      sessionState: live.state,
      technicianOnline,
    });
  }
  // A waiting / held Desk learns that its token expired or was revoked instead of waiting forever (SEC-03).
  const status = tok ? effectiveStatus(tok) : 'revoked';
  if (status !== 'active') return tokenGone(conn, status, msg.id);
  await markDeskWaiting(hub, conn);
  conn.send({ t: 'poll.status', ...re(msg.id), state: d.held ? 'held' : 'waiting', technicianOnline });
}

export async function handleDeskKnock(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.knock'>): Promise<void> {
  const { ctx } = hub;
  const d = conn.desk!;
  const live = d.sessionId ? hub.live.get(d.sessionId) : undefined;
  if (live && live.state !== 'ended') return conn.error('bad_state', 'this Desk already has a live session', msg.id);
  const tok = await findTokenByTid(ctx.db, d.tokenId);
  if (!tok || effectiveStatus(tok) !== 'active') return tokenGone(conn, tok ? effectiveStatus(tok) : 'revoked', msg.id);
  if (await findOpenSessionByToken(ctx.db, tok.id)) return conn.error('token_busy', 'token is busy', msg.id);
  const lim = ctx.limiter.hit(`knock:${tok.id}`, 5, 10 * 60_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    return conn.error('rate_limited', 'too many knocks on this token', msg.id, { retryAfterSec: lim.retryAfterSec });
  }
  const label = deskLabelOf(msg.deskLabel ?? d.helloLabel);
  if (hub.assistsForToken(tok).length === 0) {
    d.held = true;
    d.heldLabel = label;
    await markDeskWaiting(hub, conn);
    conn.send({ t: 'knock.held', ...re(msg.id), technicianOnline: false });
    await notifyTokenPresence(hub, tok.id);
    return;
  }
  await performKnock(hub, conn, tok, label, { reId: msg.id });
}

export async function handleDeskConsent(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.consent'>): Promise<void> {
  const { ctx } = hub;
  const sid = conn.desk!.sessionId;
  const live = sid ? hub.live.get(sid) : undefined;
  if (!sid || !live || live.deskConnId !== conn.id || live.state === 'ended')
    return conn.error('session_not_found', 'no live session for this Desk', msg.id);
  const s = (await getSession(ctx.db, sid))!;
  const org = await orgOf(hub, s.orgId);
  const assistConn = hub.conn(live.assistConnId);
  if (msg.state === 'granted') {
    if (s.state !== 'consent_pending') return conn.error('bad_state', `cannot grant consent in ${s.state}`, msg.id);
    const surface = msg.surface ?? 'unknown';
    const tok = await findTokenByTid(ctx.db, s.tokenId);
    await ctx.db.transaction(async (tx) => {
      const r = await transitionSession(tx, s.id, 'active', { from: 'consent_pending', set: { consentSurface: surface } });
      if (tok?.typ === 'one_time') await markTokenUsed(tx, tok.id);
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor: deskActor(s.deskRef),
        action: 'session.consent_granted',
        data: { surface },
      });
      await writeAudit(ctx, tx, org, { sessionId: s.id, actor: systemActor, action: 'session.started', data: { path: r.path } });
    });
    live.state = 'active';
    stopConsentTimer(live);
    ctx.metrics.sessionsActive.inc();
    conn.send({ t: 'consent.ok', ...re(msg.id), sessionId: s.id, state: 'active', consentState: 'granted', ...deskIce(hub, s.id) });
    assistConn?.send({ t: 'consent.changed', sessionId: s.id, state: 'granted', surface });
    scheduleIceRefresh(hub, live, 'desk');
    return;
  }
  // Section 7.4: consent can be revoked only once it was asked for (consent_pending) or given (active).
  if (s.state !== 'consent_pending' && s.state !== 'active')
    return conn.error('bad_state', `cannot revoke consent in ${s.state}`, msg.id);
  await endSessionFlow(ctx, s.id, {
    reason: 'consent_revoked',
    actor: deskActor(s.deskRef),
    from: ['consent_pending', 'active'],
    before: async (tx, o) => {
      await writeAudit(ctx, tx, o, { sessionId: s.id, actor: deskActor(s.deskRef), action: 'session.consent_revoked' });
    },
    beforePush: () => {
      conn.send({ t: 'consent.ok', ...re(msg.id), sessionId: s.id, state: 'ended', consentState: 'revoked' });
      assistConn?.send({ t: 'consent.changed', sessionId: s.id, state: 'revoked' });
    },
  });
}
