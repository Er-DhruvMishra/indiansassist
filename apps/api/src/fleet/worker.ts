/**
 * Phase D worker credential (docs/specs/phase-d-contracts.md section 4.2, rule 3.6d, W31): 32 CSPRNG bytes minted by
 * the server, delivered to the service only over the authenticated device socket (`device.session_open` for gen 0,
 * `device.worker_credential` per rebuild / reconnect), stored `ia:wc:<sha256Hex(cred)>` for 120 s and consumed on first
 * use. The desktop worker presents it as `desk.hello { workerCredential }` with no token; the socket is then
 * registered as the session's Desk through the same steps as the C section 7.2 hand-over registration.
 */
import { randomBytes } from 'node:crypto';
import { isNativeTier, LIMITS, sha256Hex, WS_CLOSE, type DeviceClientOf, type SignalOf } from '@indiansassist/shared';
import {
  getDevice,
  getOrg,
  getSession,
  lockSession,
  replaceParticipant,
  SessionAlreadyEndedError,
  updateSession,
  type DeviceRow,
  type OrgRow,
  type SessionRow,
} from '@indiansassist/db';
import { refOf, userRefs } from '../lib/lookup.js';
import { brandingPublic } from '../lib/mappers.js';
import { iso } from '../lib/time.js';
import { ensureAgentManifest } from '../signal/agent-manifest.js';
import type { Conn } from '../signal/conn.js';
import type { DeviceConn, DeviceHub } from '../signal/device.js';
import { pushAgentConsent } from '../signal/desk-p3.js';
import type { SignalHub } from '../signal/hub.js';
import { cancelGrace, startDeskGrace } from '../signal/lifecycle.js';
import { deskIce, ensureLive, scheduleIceRefresh, sessionCreatedMsg } from '../signal/messages.js';
import { onDeskHandedOver } from '../signal/recorder.js';
import { refuseIfOrgErasing } from '../erasure/guard.js';
import { featuresOf } from './common.js';
import { ensureP4Device } from './session-hooks.js';

export type WorkerCredentialEntry = { sessionId: string; deviceId: string; gen: number };
export const workerCredentialKey = (cred: string) => `ia:wc:${sha256Hex(cred)}`;

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

/** Mints a single-use worker credential for (session, device, gen). */
export async function mintWorkerCredential(hub: SignalHub, e: WorkerCredentialEntry): Promise<{ workerCredential: string; expiresAt: string }> {
  const workerCredential = randomBytes(32).toString('base64url');
  await hub.ctx.presence.setKey(workerCredentialKey(workerCredential), JSON.stringify(e), LIMITS.workerCredentialTtlSec);
  return { workerCredential, expiresAt: iso(new Date(Date.now() + LIMITS.workerCredentialTtlSec * 1000)) };
}

/** `device.worker_credential.request { sessionId, gen }` (rebuild or worker reconnect). */
export async function handleWorkerCredentialRequest(dh: DeviceHub, conn: DeviceConn, msg: DeviceClientOf<'device.worker_credential.request'>): Promise<void> {
  const s = await getSession(dh.ctx.db, msg.sessionId);
  if (!s || s.state === 'ended' || s.deviceId !== conn.deviceId || s.tier !== 'p4_installed')
    return conn.error('bad_state', 'no live session of this device', msg.id);
  const live = dh.hub.live.get(s.id);
  if (live?.p4) live.p4.gen = Math.max(live.p4.gen, msg.gen);
  const cred = await mintWorkerCredential(dh.hub, { sessionId: s.id, deviceId: s.deviceId!, gen: msg.gen });
  conn.send({ t: 'device.worker_credential', ...re(msg.id), sessionId: s.id, gen: msg.gen, workerCredential: cred.workerCredential, expiresAt: cred.expiresAt });
}

function refuseWorker(conn: Conn, code: 'unauthenticated' | 'capability_mismatch' | 'session_not_found', message: string, reId: string | undefined): void {
  conn.side = null;
  conn.desk = null;
  conn.error(code, message, reId);
  conn.close(code === 'unauthenticated' ? WS_CLOSE.unauthenticated : WS_CLOSE.forbidden, code);
}

/** `desk.hello { workerCredential }` (section 4.2). */
export async function workerHello(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.hello'>): Promise<void> {
  const { ctx } = hub;
  if (!conn.deskOnly || conn.extensionOrigin || msg.client?.kind !== 'native')
    return refuseWorker(conn, 'unauthenticated', 'a worker credential is presented by the native desktop worker only', msg.id);
  const raw = await ctx.presence.consume(workerCredentialKey(msg.workerCredential!));
  let entry: WorkerCredentialEntry | null;
  try {
    entry = raw ? (JSON.parse(raw) as WorkerCredentialEntry) : null;
  } catch {
    entry = null;
  }
  if (!entry) return refuseWorker(conn, 'unauthenticated', 'the worker credential is missing, spent or expired', msg.id);
  const s = await getSession(ctx.db, entry.sessionId);
  if (!s || s.state === 'ended' || s.deviceId !== entry.deviceId || s.tier !== 'p4_installed')
    return refuseWorker(conn, 'session_not_found', 'the session of this credential is not live', msg.id);
  const d = await getDevice(ctx.db, entry.deviceId);
  const org = d ? await getOrg(ctx.db, d.orgId) : null;
  if (!d || !org || d.status !== 'enrolled') return refuseWorker(conn, 'session_not_found', 'the device is not enrolled', msg.id);
  // Phase F section 5.3 step 1: no worker of an org whose erasure is executing connects (`org_erasing`, 4403).
  if (refuseIfOrgErasing(conn, org, msg.id)) return;
  const allowed = new Set(featuresOf(d));
  const asked = msg.client.capabilities?.features ?? [];
  if (!asked.every((f) => allowed.has(f))) return refuseWorker(conn, 'capability_mismatch', 'the worker advertises features the device did not report', msg.id);
  conn.side = 'desk';
  conn.desk = {
    tokenId: `device:${d.id}`,
    deviceId: d.id,
    orgId: d.orgId,
    via: 'compact',
    helloLabel: d.name,
    sessionId: null,
    held: false,
    heldLabel: null,
    tokenExpiresAt: Number.MAX_SAFE_INTEGER,
    client: msg.client ?? null,
  };
  // Rule 3.6d: a session owned by another live node is completed there (A section 7.6); a lost owner is adopted.
  if (await hub.bridge.forwardWorkerHello(conn, s, entry.gen, msg.id)) return;
  return completeWorkerHello(hub, conn, { session: s, device: d, org }, entry.gen, msg.id);
}

/** Registration of the worker socket as the session's Desk (the C section 7.2 steps, on the owner node). */
export async function completeWorkerHello(
  hub: SignalHub,
  conn: Conn,
  t: { session: SessionRow; device: DeviceRow; org: OrgRow },
  gen: number,
  reId: string | undefined,
): Promise<void> {
  const { ctx } = hub;
  const s0 = t.session;
  const live = ensureLive(hub, s0);
  const previousConnId = live.deskConnId;
  live.deskConnId = conn.id;
  cancelGrace(hub, s0.id, 'desk');
  conn.desk!.sessionId = s0.id;
  try {
    await ctx.db.transaction(async (tx) => {
      const locked = await lockSession(tx, s0.id);
      if (!locked || locked.state === 'ended') throw new SessionAlreadyEndedError('ended');
      await replaceParticipant(tx, { sessionId: s0.id, role: 'desk', label: t.device.name, connectionId: conn.id });
      await updateSession(tx, s0.id, { nodeId: ctx.config.nodeId, ...(conn.desk!.client ? { deskClient: conn.desk!.client as Record<string, unknown> } : {}) });
    });
  } catch {
    if (live.deskConnId === conn.id) live.deskConnId = hub.conn(previousConnId) ? previousConnId : null;
    if (live.deskConnId === null && live.state !== 'ended') startDeskGrace(hub, live);
    return refuseWorker(conn, 'session_not_found', 'the session ended during the worker hello', reId);
  }
  const s = (await getSession(ctx.db, s0.id))!;
  ensureLive(hub, s);
  if (live.p4) live.p4.gen = Math.max(live.p4.gen, gen);
  await ensureAgentManifest(hub, live, s);
  await ensureP4Device(hub, live);
  conn.send({
    t: 'desk.hello.ok',
    ...re(reId),
    connectionId: conn.id,
    tokenId: null,
    tier: s.tier,
    technician: { name: refOf(await userRefs(ctx.db, [s.assistUserId]), s.assistUserId).name },
    org: brandingPublic(t.org),
    region: t.org.dataRegion,
    resume: { sessionId: s.id, state: s.state, consentState: s.consentState },
  });
  const assistRef = refOf(await userRefs(ctx.db, [s.assistUserId]), s.assistUserId);
  conn.send(sessionCreatedMsg(hub, s, t.org, assistRef, 'desk'));
  const previous = previousConnId !== conn.id ? hub.conn(previousConnId) : null;
  if (previous) {
    previous.send({ t: 'session.handed_over', sessionId: s.id });
    if (previous.desk) previous.desk.sessionId = null;
    previous.close(WS_CLOSE.handedOver, 'replaced by a new desktop worker');
  }
  if (s.state === 'active') {
    // A desktop-switch rebuild (section 5.3) or a worker reconnect: fresh TURN credentials, the console learns it.
    conn.send({ t: 'ice.refresh', sessionId: s.id, ...deskIce(hub, s.id) });
    scheduleIceRefresh(hub, live, 'desk');
    hub.conn(live.assistConnId)?.send({ t: 'desk.reconnected', sessionId: s.id, state: 'active', consentState: 'granted' });
    if (live.agent && isNativeTier(s.tier)) pushAgentConsent(hub, live, live.agent);
    await onDeskHandedOver(hub, live);
  }
}
