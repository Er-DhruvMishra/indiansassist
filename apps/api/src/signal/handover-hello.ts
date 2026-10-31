/**
 * The elevated instance's `desk.hello { handover }` (docs/specs/phase-c-contracts.md section 7.2, binding order):
 * (1) token verification with the hand-over relaxation (services/token-verify.ts), (2) atomic `Presence.consume`,
 * (3) entry vs session / token / org / region / expiry and the row fields, (4) the native Windows client of the same
 * arch that advertised `elevation`, (5) `active` re-checked under the row lock, (6) bridged to the owner node, (7)
 * registration with a fresh resume key, `elevation = admin`, `consent_level = elevated`, and (8) the replies, the
 * old socket's `session.handed_over` + close 4411 and the recorder pause / re-assign.
 */
import { randomBytes } from 'node:crypto';
import { isRegionServed, sha256Hex, WS_CLOSE, type SignalOf } from '@indiansassist/shared';
import {
  clearSessionHandover,
  getSession,
  lockSession,
  replaceParticipant,
  SessionAlreadyEndedError,
  settleHandover,
  updateSession,
  type OrgRow,
  type SessionRow,
  type TokenRow,
} from '@indiansassist/db';
import { deskActor, systemActor, writeAudit } from '../lib/audit.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { brandingPublic } from '../lib/mappers.js';
import type { TokenVerifyOk } from '../services/token-verify.js';
import { ensureAgentManifest } from './agent-manifest.js';
import { agentOfRow, type Conn } from './conn.js';
import { pushAgentConsent } from './desk-p3.js';
import { handoverKey, type HandoverEntry } from './handover.js';
import type { SignalHub } from './hub.js';
import { cancelGrace, startDeskGrace } from './lifecycle.js';
import { deskIce, ensureLive, scheduleIceRefresh, sessionCreatedMsg } from './messages.js';
import { assignRecorder, pauseRecorder } from './recorder.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

type ClientLike = { kind?: string; os?: string; platform?: { arch?: string }; capabilities?: { elevation?: string; features?: string[] } } | null;

/**
 * Any failure of (1)-(5): `error forbidden` + close 4403. Only a hello that actually consumed the token (`settle`)
 * settles the row and chains `elevation.failed { handover_rejected }`, and only under a fresh row lock that still
 * names this `hash` and leaves `settleHandover` succeeding (i.e. unclaimed). A hello that LOST the atomic consume
 * passes `settle = false` and writes nothing, so it can never settle the winner's claim, wipe the live hand-over or
 * fail the winner's transaction (C10/F10); a late / superseded / expired value likewise touches nothing (the sweeper
 * owns `handover_expired`).
 */
async function reject(
  hub: SignalHub,
  conn: Conn,
  reId: string | undefined,
  why: string,
  s?: SessionRow | null,
  org?: OrgRow | null,
  entry?: HandoverEntry | null,
  hash?: string,
  settle = false,
): Promise<void> {
  const { ctx } = hub;
  ctx.log.warn({ connectionId: conn.id, sessionId: s?.id, why }, 'hand-over refused');
  const opId = s?.handoverOpid ?? entry?.opId ?? null;
  if (settle && s && org && hash && opId && /^[0-9a-f]{16}$/.test(opId)) {
    await ctx.db.transaction(async (tx) => {
      const locked = await lockSession(tx, s.id);
      if (!locked || locked.handoverHash !== hash) return; // a concurrent claim / supersede / clear won: leave it
      if (!(await settleHandover(tx, hash, 'rejected'))) return; // already claimed or settled
      await clearSessionHandover(tx, s.id, hash);
      await writeAudit(ctx, tx, org, { sessionId: s.id, actor: systemActor, action: 'elevation.failed', data: { opId, error: 'handover_rejected' } });
    });
  }
  conn.side = null;
  conn.desk = null;
  conn.error('forbidden', 'hand-over refused', reId);
  conn.close(WS_CLOSE.forbidden, 'forbidden');
}

/** Steps (1)-(6); `v` is null when step (1) failed. */
export async function handoverHello(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.hello'>, v: TokenVerifyOk | null): Promise<void> {
  const { ctx } = hub;
  const s = v?.handoverSession ?? null;
  if (!v || !s) return reject(hub, conn, msg.id, 'no session holds this hand-over');
  const hash = sha256Hex(msg.handover!);
  const raw = await ctx.presence.consume(handoverKey(hash)); // (2) exactly one of two racing hellos wins
  let entry: HandoverEntry | null;
  try {
    entry = raw ? (JSON.parse(raw) as HandoverEntry) : null;
  } catch {
    entry = null;
  }
  if (!entry) return reject(hub, conn, msg.id, 'hand-over consumed or expired', s, v.org, null, hash);
  const tok = v.token;
  const fieldsOk =
    entry.sessionId === s.id &&
    entry.tokenId === tok.id &&
    entry.orgId === tok.orgId &&
    entry.region === s.region &&
    isRegionServed(entry.region, ctx.config.servedRegions) &&
    entry.expiresAt > Date.now() &&
    s.handoverHash === hash &&
    s.handoverOpid === entry.opId;
  if (!fieldsOk) return reject(hub, conn, msg.id, 'hand-over entry does not match', s, v.org, entry, hash, true); // (3)
  const client = (msg.client ?? null) as ClientLike;
  const original = (s.deskClient ?? null) as ClientLike;
  const clientOk =
    client?.kind === 'native' &&
    client.capabilities?.elevation === 'admin' &&
    client.os === 'windows' &&
    client.platform?.arch !== undefined &&
    client.platform.arch === original?.platform?.arch &&
    (original?.capabilities?.features ?? []).includes('elevation');
  if (!clientOk) return reject(hub, conn, msg.id, 'hand-over client mismatch', s, v.org, entry, hash, true); // (4)
  if (s.state !== 'active') return reject(hub, conn, msg.id, 'session not active', s, v.org, entry, hash, true); // (5)
  // (6) a session owned by another live node completes there.
  if (await hub.bridge.forwardDeskHandover(conn, v, s, entry.opId, hash, msg.id)) return;
  return completeHandover(hub, conn, { token: tok, org: v.org, session: s }, entry.opId, hash, msg.id);
}

/** Steps (5) under the lock, (7) and (8), on the session's owner node. */
export async function completeHandover(
  hub: SignalHub,
  conn: Conn,
  t: { token: TokenRow; org: OrgRow; session: SessionRow },
  opId: string,
  hash: string,
  reId: string | undefined,
): Promise<void> {
  const { ctx } = hub;
  const s0 = t.session;
  const live = ensureLive(hub, s0);
  const previousConnId = live.deskConnId;
  const fromLevel = (live.agent ?? agentOfRow(s0))?.level ?? 'control';
  live.deskConnId = conn.id;
  cancelGrace(hub, s0.id, 'desk');
  conn.desk!.sessionId = s0.id;
  const resumeKey = randomBytes(32).toString('base64url');
  try {
    await ctx.db.transaction(async (tx) => {
      const locked = await lockSession(tx, s0.id);
      if (!locked || locked.state !== 'active' || locked.handoverHash !== hash) throw new SessionAlreadyEndedError('active');
      await replaceParticipant(tx, { sessionId: s0.id, role: 'desk', label: s0.deskLabel ?? 'Desk', connectionId: conn.id });
      await updateSession(tx, s0.id, {
        resumeKeyHash: sha256Hex(resumeKey),
        elevation: 'admin',
        consentLevel: 'elevated',
        handoverHash: null,
        handoverOpid: null,
        handoverExpiresAt: null,
        nodeId: ctx.config.nodeId,
        ...(conn.desk!.client ? { deskClient: conn.desk!.client as Record<string, unknown> } : {}),
      });
      await settleHandover(tx, hash, 'claimed');
      const desk = deskActor(s0.deskRef);
      await writeAudit(ctx, tx, t.org, { sessionId: s0.id, actor: desk, action: 'elevation.granted', data: { opId, elevation: 'admin', claimed: true } });
      await writeAudit(ctx, tx, t.org, { sessionId: s0.id, actor: systemActor, action: 'session.resumed', data: { side: 'desk', fromState: 'active', toState: 'active' } });
      await writeAudit(ctx, tx, t.org, {
        sessionId: s0.id,
        actor: desk,
        action: 'consent.level_changed',
        data: { from: fromLevel, to: 'elevated', requestedBy: 'assist', opId },
      });
    });
  } catch {
    if (live.deskConnId === conn.id) live.deskConnId = hub.conn(previousConnId) ? previousConnId : null;
    if (live.deskConnId === null && live.state !== 'ended') startDeskGrace(hub, live);
    return reject(hub, conn, reId, 'session changed during the hand-over', s0, t.org, null, hash, true);
  }
  const s = (await getSession(ctx.db, s0.id))!;
  ensureLive(hub, s);
  live.agent = agentOfRow(s);
  await ensureAgentManifest(hub, live, s);
  const creator = t.token ? refOf(await userRefs(ctx.db, [t.token.createdBy]), t.token.createdBy) : null;
  conn.send({
    t: 'desk.hello.ok',
    ...re(reId),
    connectionId: conn.id,
    tokenId: t.token.id,
    tier: t.token.tier,
    technician: creator ? { name: creator.name } : null,
    org: brandingPublic(t.org),
    region: t.org.dataRegion,
    resume: { sessionId: s.id, state: 'active', consentState: 'granted' },
    resumeKey,
  });
  const assistRef = refOf(await userRefs(ctx.db, [s.assistUserId]), s.assistUserId);
  conn.send(sessionCreatedMsg(hub, s, t.org, assistRef, 'desk'));
  conn.send({ t: 'ice.refresh', sessionId: s.id, ...deskIce(hub, s.id) });
  scheduleIceRefresh(hub, live, 'desk');
  const previous = previousConnId !== conn.id ? hub.conn(previousConnId) : null;
  if (previous) {
    previous.send({ t: 'session.handed_over', sessionId: s.id });
    if (previous.desk) previous.desk.sessionId = null;
    previous.close(WS_CLOSE.handedOver, 'handed over');
  }
  hub.conn(live.assistConnId)?.send({ t: 'desk.reconnected', sessionId: s.id, state: 'active', consentState: 'granted' });
  if (live.agent) pushAgentConsent(hub, live, live.agent);
  // Section 3.7: the recorder PC died with the old process; pause, then re-assign the same recorder to re-offer.
  if (live.recorder.joined) {
    pauseRecorder(hub, live);
    await assignRecorder(hub, live, true);
  }
}
