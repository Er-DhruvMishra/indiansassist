/**
 * Desk-side signaling handlers (contracts sections 7.2, 7.3, 7.5): `desk.hello` (section 3.5 verification, resume),
 * `desk.poll`, `desk.knock` (held knocks when no technician can act) and `desk.consent`. The knock itself lives in
 * knock.ts and `desk.event` in desk-events.ts.
 */
import { WS_CLOSE, type PackageTier, type SignalErrorCode, type SignalOf } from '@indiansassist/shared';
import { retireDeskCodes } from '../lib/desk-codes.js';
import { ensureAgentManifest } from './agent-manifest.js';
import { checkNativeGrant, pushAgentConsent } from './desk-p3.js';
import { handoverHello } from './handover-hello.js';
import { workerHello } from '../fleet/worker.js';
import { refuseIfOrgErasing } from '../erasure/guard.js';
import { p4ConsentEntries, p4ConsentRevokeReason, p4OnActive } from '../fleet/session-hooks.js';
import {
  findOpenSessionByToken,
  findTokenByTid,
  getSession,
  lockSession,
  markTokenUsed,
  replaceParticipant,
  SessionAlreadyEndedError,
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
import { checkGrant } from './desk-consent.js';
import { performKnock } from './knock.js';
import { onSessionActive, pauseRecorder } from './recorder.js';
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

/** Tier gate (Phase B 2.4, Phase C section 3.1): which client kind may join each tier. */
export const EXPECTED_CLIENT: Partial<Record<PackageTier, 'web' | 'extension' | 'native'>> = {
  p1_browser: 'web',
  p2_extension: 'extension',
  p3_portable: 'native',
  // Phase D section 16.2: the P4 desktop worker is native; it joins with a worker credential (a p4 token never joins).
  p4_installed: 'native',
};

/** `a < b` for MAJOR.MINOR.PATCH (a pre-release suffix sorts below its release). */
export function versionBelow(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split('-', 2);
    return { n: (core ?? '').split('.').map((x) => Number(x) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) < (y.n[i] ?? 0);
  return x.pre && !y.pre;
}

export async function handleDeskHello(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.hello'>): Promise<void> {
  const { ctx } = hub;
  // Phase C section 3.1: a resume or hand-over hello has its own, larger IP bucket (an office of agents behind one NAT).
  const resuming = msg.resumeKey !== undefined || msg.handover !== undefined;
  const lim = await ctx.limiter.hit(resuming ? `desk-hello-resume:${conn.ip}` : `desk-hello:${conn.ip}`, resuming ? 120 : 30, 60_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    conn.error('rate_limited', 'too many attempts', msg.id, { retryAfterSec: lim.retryAfterSec });
    return conn.close(WS_CLOSE.rateLimited, 'rate limited');
  }
  // Phase D section 4.2: the P4 desktop worker presents a single-use worker credential instead of a token.
  if (msg.workerCredential !== undefined) return workerHello(hub, conn, msg);
  const native = msg.client?.kind === 'native';
  const v = await verifyTokenInput(ctx, msg.token!, {
    ip: conn.ip,
    ...(msg.resumeKey ? { resumeKey: msg.resumeKey } : {}),
    ...(msg.handover ? { handover: msg.handover } : {}),
    deskCode: native,
  });
  if (!v.ok && msg.handover) return handoverHello(hub, conn, msg, null);
  if (!v.ok) {
    conn.error(v.code as SignalErrorCode, v.message, msg.id, v.details);
    return conn.close(v.code === 'rate_limited' ? WS_CLOSE.rateLimited : WS_CLOSE.forbidden, v.code);
  }
  // Phase F section 5.3 step 1: no Desk of an org whose erasure is executing connects (`org_erasing`, 4403).
  if (refuseIfOrgErasing(conn, v.org, msg.id)) return;
  const tok = v.token;
  // Tier gate (Phase B 2.4): p1 needs a web client, p2 the extension; p3 / p4 / enrollment stay unsupported.
  // Phase D section 2.1: a p4_installed / enrollment token still answers join_unsupported (devices use /signal/device).
  const expectedClient = tok.typ === 'enrollment' || tok.tier === 'p4_installed' ? null : EXPECTED_CLIENT[tok.tier];
  if (!expectedClient || (msg.client?.kind ?? 'web') !== expectedClient) {
    conn.error('join_unsupported', 'this code needs a different IndiansAssist client', msg.id, {
      tier: tok.tier,
      expectedClient: expectedClient ?? null,
    });
    return conn.close(WS_CLOSE.forbidden, 'join_unsupported');
  }
  if (expectedClient === 'native' && versionBelow(msg.client?.version ?? '0.0.0', ctx.config.agent.minVersion)) {
    conn.error('join_unsupported', 'this IndiansAssist client is too old', msg.id, {
      tier: tok.tier,
      expectedClient,
      minVersion: ctx.config.agent.minVersion,
    });
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
    client: msg.client ?? null,
  };
  if (msg.handover) return handoverHello(hub, conn, msg, v);
  if (v.resumeSession) {
    // A session owned by another live node is resumed there; this node pipes the socket (section 7.6 N1).
    if (await hub.bridge.forwardDeskResume(conn, v, msg.id)) return;
    return deskResume(hub, conn, v, msg.id);
  }
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
export async function deskResume(hub: SignalHub, conn: Conn, v: TokenVerifyOk, reId: string | undefined): Promise<void> {
  const { ctx } = hub;
  const s0 = v.resumeSession!;
  // Phase B 3.5 (Y2): an extension Desk resumes into `active` (consent is a decision, nothing was lost); Phase C
  // section 3.2: so does a native Desk.
  const kind = conn.desk?.client?.kind;
  const keepsActive = s0.state === 'active' && (kind === 'extension' || kind === 'native');
  const wasActive = s0.state === 'active' && !keepsActive;
  const hadLive = hub.live.has(s0.id);
  const live = ensureLive(hub, s0);
  const previousConnId = live.deskConnId;
  live.deskConnId = conn.id;
  cancelGrace(hub, s0.id, 'desk');
  conn.desk!.sessionId = s0.id;
  try {
    await ctx.db.transaction(async (tx) => {
      const locked = await lockSession(tx, s0.id); // session row before its participant rows (lock order, F1)
      if (!locked || locked.state === 'ended') throw new SessionAlreadyEndedError('ended');
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
  await ensureAgentManifest(hub, live, s);
  conn.send(sessionCreatedMsg(hub, s, v.org, assistRef, 'desk'));
  if (keepsActive) {
    // Fresh TURN credentials; the Desk rebuilds its peer connection on this ice.refresh (Y23).
    conn.send({ t: 'ice.refresh', sessionId: s.id, ...deskIce(hub, s.id) });
    scheduleIceRefresh(hub, live, 'desk');
  }
  hub.conn(live.assistConnId)?.send({
    t: 'desk.reconnected',
    sessionId: s.id,
    state: s.state,
    consentState: s.consentState,
  });
  if (wasActive) {
    ctx.metrics.sessionsActive.dec();
    startConsentTimer(hub, live);
    pauseRecorder(hub, live);
  }
}

/** Closes a waiting Desk whose token is no longer usable (section 3.5 step 7). */
function tokenGone(conn: Conn, status: string, reId: string | undefined): void {
  conn.error('token_gone', `token is ${status}`, reId, { status });
  conn.close(WS_CLOSE.forbidden, 'token gone');
}

export async function handleDeskPoll(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.poll'>): Promise<void> {
  const d = conn.desk!;
  if (d.deviceId) return conn.error('bad_state', 'a desktop worker does not poll', msg.id);
  const tok = await findTokenByTid(hub.ctx.db, d.tokenId);
  const technicianOnline = tok ? await hub.techOnline(tok) : false;
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
  if (d.deviceId) return conn.error('bad_state', 'a desktop worker does not knock', msg.id);
  const live = d.sessionId ? hub.live.get(d.sessionId) : undefined;
  if (live && live.state !== 'ended') return conn.error('bad_state', 'this Desk already has a live session', msg.id);
  const tok = await findTokenByTid(ctx.db, d.tokenId);
  if (!tok || effectiveStatus(tok) !== 'active') return tokenGone(conn, tok ? effectiveStatus(tok) : 'revoked', msg.id);
  if (await findOpenSessionByToken(ctx.db, tok.id)) return conn.error('token_busy', 'token is busy', msg.id);
  const lim = await ctx.limiter.hit(`knock:${tok.id}`, 5, 10 * 60_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    return conn.error('rate_limited', 'too many knocks on this token', msg.id, { retryAfterSec: lim.retryAfterSec });
  }
  const label = deskLabelOf(msg.deskLabel ?? d.helloLabel);
  if (!(await hub.techOnline(tok))) {
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
    // Phase B 3.1: `extension` is required for p2 (and validated against the policy), rejected for p1.
    const ext = await checkGrant(hub, live, s.tier, msg.extension);
    if (!ext.ok) return conn.error('bad_payload', ext.message, msg.id);
    // Phase C section 3.4: `native` is required for p3 and rejected otherwise.
    const nat = checkNativeGrant(s.tier, msg.surface, msg.native);
    if (!nat.ok) return conn.error('bad_payload', nat.message, msg.id);
    const ag = nat.agent;
    const surface = msg.surface ?? 'unknown';
    const tok = s.tokenId ? await findTokenByTid(ctx.db, s.tokenId) : null;
    const c = ext.consent;
    await ctx.db.transaction(async (tx) => {
      const r = await transitionSession(tx, s.id, 'active', {
        from: 'consent_pending',
        set: {
          consentSurface: surface,
          ...(c ? { consentLevel: c.level, consentScope: c.scope, consentBackstage: c.backstage } : {}),
          ...(ag ? { consentLevel: ag.level, consentMonitors: ag.monitors, consentClipboard: ag.clipboard } : {}),
        },
      });
      if (tok?.typ === 'one_time') await markTokenUsed(tx, tok.id);
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor: deskActor(s.deskRef),
        action: 'session.consent_granted',
        data: ag ? { surface: 'monitor', level: ag.level, monitors: ag.monitors, clipboard: ag.clipboard } : { surface, ...(c ?? {}) },
      });
      await writeAudit(ctx, tx, org, { sessionId: s.id, actor: systemActor, action: 'session.started', data: { path: r.path } });
      // Phase D section 6.3: an unattended P4 session chains `session.unattended_started` when it reaches active.
      if (s.deviceId) await p4ConsentEntries(hub, tx, org, live, s, msg.approvedBy);
    });
    live.state = 'active';
    live.consent = c;
    if (ag) live.agent = ag;
    stopConsentTimer(live);
    // Phase C section 2.2: the desk codes of the token stop opening new joins once a session reached active.
    if (tok && s.tier === 'p3_portable') await retireDeskCodes(ctx, tok);
    ctx.metrics.sessionsActive.inc();
    conn.send({ t: 'consent.ok', ...re(msg.id), sessionId: s.id, state: 'active', consentState: 'granted', ...deskIce(hub, s.id) });
    if (ag) pushAgentConsent(hub, live, ag);
    else assistConn?.send({ t: 'consent.changed', sessionId: s.id, state: 'granted', surface, ...(c ?? {}) });
    scheduleIceRefresh(hub, live, 'desk');
    await onSessionActive(hub, live);
    if (live.p4) p4OnActive(hub, live);
    return;
  }
  // Section 7.4: consent can be revoked only once it was asked for (consent_pending) or given (active).
  if (s.state !== 'consent_pending' && s.state !== 'active')
    return conn.error('bad_state', `cannot revoke consent in ${s.state}`, msg.id);
  await endSessionFlow(ctx, s.id, {
    // Phase D section 6.2: a P4 local approval / consent declined (or left unanswered) ends `consent_required`.
    reason: s.deviceId ? p4ConsentRevokeReason(s) : 'consent_revoked',
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
