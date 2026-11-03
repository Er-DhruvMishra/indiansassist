/**
 * Phase F stream camera (docs/specs/phase-f-contracts.md sections 6.4, 6.5a): the phone camera's `/signal` side.
 * `camera.hello` resolves a link code or a resume key to a live session; `camera.ready` and `camera.stop` report the
 * track; `routeCameraWebrtc` relays the camera <-> Assist peer connection (`peer: 'camera'`) and
 * `routeCameraRecorderWebrtc` the camera <-> recorder one (`peer: 'recorder'` from the camera side).
 *
 * Everything runs on the session's owner node against `Live.camera`. A per-hub watcher (every 250 ms while a camera
 * exists) applies what the shared files do not call this module for: a dropped phone socket (60 s resume, then
 * `disconnected`), the session's end (`session_ended`), the recorder taking the camera (`recorder.camera`) and the
 * phone's "Recording" bar (`camera.state { recording }`).
 *
 * Frames from the phone reach the Assist as `webrtc.* { peer: 'camera', sessionId: <cameraId> }`: the console's
 * session controllers match frames on `sessionId` only, so a camera frame carrying the session id would be fed into
 * the Desk's peer connection. The Assist answers with the real session id and `peer: 'camera'`.
 */
import { randomBytes } from 'node:crypto';
import {
  assistMayRecord,
  base64urlEncode,
  isNativeTier,
  LIMITS,
  normaliseCameraCode,
  recorderActor,
  serverRecords,
  sha256Hex,
  WS_CLOSE,
  type CameraRecording,
  type CameraStopReason,
  type SignalOf,
} from '@indiansassist/shared';
import { closeParticipants, getSession, replaceParticipant, type OrgRow } from '@indiansassist/db';
import {
  CAMERA_SESSION_CONNECTED_TTL_SEC,
  cameraCodeHash,
  clearCameraSession,
  consumeCameraLink,
  peekCameraLink,
  readCameraSession,
  writeCameraSession,
} from '../camera/state.js';
import { deskActor, systemActor, writeAudit } from '../lib/audit.js';
import { buildIceServers } from '../lib/ice.js';
import { refOf, userRefs } from '../lib/lookup.js';
import { CAMERA_METRIC_TIERS } from '../lib/metrics.js';
import { refuseIfOrgErasing } from '../erasure/guard.js';
import type { Conn, Live } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';
import { recordableSession } from './recorder.js';

type WebrtcMsg = SignalOf<'webrtc.offer'> | SignalOf<'webrtc.answer'> | SignalOf<'webrtc.ice'>;

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});
const WATCH_MS = 250;
/** The 60 s resume window of a dropped phone (section 6.4, `LIMITS.cameraResumeSec`); tests shorten it. */
export const cameraTiming = { resumeMs: LIMITS.cameraResumeSec * 1000 };
/** How often the console-recording flag of a live camera is re-read from the session row. */
const CONSOLE_POLL_MS = 2_000;
/** Reasons a phone may give in `camera.stop`; anything else is read as `phone_stopped`. */
const PHONE_REASONS = new Set<CameraStopReason>([
  'declined',
  'phone_stopped',
  'no_camera',
  'permission_denied',
  'error',
]);

/** Per-session camera bookkeeping that does not belong on `Live` (owner node only). */
type CameraExtra = {
  cameraId: string;
  /** Ms epoch until which a dropped phone may resume (null while its socket is up). */
  resumeUntil: number | null;
  /** The recorder socket `recorder.camera` was sent to, and its recorder id (for the chain). */
  recorderConnId: string | null;
  recorderId: string | null;
  recording: CameraRecording;
  consoleRecording: boolean;
  consolePolledAt: number;
  busy: boolean;
};

type Runtime = { extra: Map<string, CameraExtra>; timer: NodeJS.Timeout | null };
const runtimes = new WeakMap<SignalHub, Runtime>();

function runtime(hub: SignalHub): Runtime {
  let rt = runtimes.get(hub);
  if (!rt) {
    rt = { extra: new Map(), timer: null };
    runtimes.set(hub, rt);
  }
  return rt;
}

function ensureWatcher(hub: SignalHub): void {
  const rt = runtime(hub);
  if (rt.timer) return;
  rt.timer = setInterval(
    () => {
      void watch(hub).catch((err: unknown) => hub.ctx.log.error({ err }, 'camera watcher failed'));
    },
    Math.min(WATCH_MS, hub.ctx.timing.tickMs),
  );
  rt.timer.unref?.();
}

/** Stops the watcher of a hub (app close). */
export function stopCameraWatcher(hub: SignalHub): void {
  const rt = runtimes.get(hub);
  if (rt?.timer) clearInterval(rt.timer);
  if (rt) rt.timer = null;
}

function liveOfConn(hub: SignalHub, conn: Conn): Live | null {
  for (const live of hub.live.values()) if (live.camera && live.camera.connId === conn.id) return live;
  return null;
}

// ---------- recording state (section 6.5a) ----------

/** The server recorder records this session now (or must): the camera must then be recorded by it too. */
export function serverRecordingInForce(live: Live): boolean {
  return recordableSession(live) && serverRecords(live.recordingMode);
}

/** The joined (or assigned) recorder socket of a session, and whether it advertised `features: ['camera']`. */
export function sessionRecorder(hub: SignalHub, live: Live): { conn: Conn | null; camera: boolean } {
  const c = hub.conn(live.recorder.connId ?? live.recorder.assignedConnId);
  const features = (c?.recorder as { features?: readonly string[] } | null | undefined)?.features;
  return { conn: c, camera: Array.isArray(features) && features.includes('camera') };
}

/** Section 6.5a: a server-recorded session whose recorder cannot take the camera refuses the link. */
export function cameraUnrecordable(hub: SignalHub, live: Live): boolean {
  if (!serverRecordingInForce(live)) return false;
  return !sessionRecorder(hub, live).camera;
}

/** The console records the camera while its own session recording runs (P1, `assist_only` / `both`). */
function consoleRecords(live: Live, recordingStarted: boolean): boolean {
  return live.tier === 'p1_browser' && assistMayRecord(live.recordingMode) && recordingStarted;
}

// ---------- pushes ----------

/** `camera.state` to the session's Assist and to a P1 Desk (native Desks do not know the message, section 6.4). */
function pushState(hub: SignalHub, live: Live, frame: Record<string, unknown>): void {
  const msg = { t: 'camera.state', ...frame };
  hub.conn(live.assistConnId)?.send(msg);
  if (live.tier === 'p1_browser') hub.conn(live.deskConnId)?.send(msg);
}

/** `camera.state` with the camera's current state, for a REST link on the owner node. */
export function pushCameraLinked(hub: SignalHub, sessionId: string, cameraId: string): void {
  const live = hub.live.get(sessionId);
  if (live) pushState(hub, live, { cameraId, state: 'linked' });
}

/** A pending link ended without a phone (revoked or expired): tells the Assist and a P1 Desk. */
export function pushCameraLinkEnded(
  hub: SignalHub,
  sessionId: string,
  cameraId: string,
  reason: CameraStopReason,
): void {
  const live = hub.live.get(sessionId);
  if (live && !live.camera) pushState(hub, live, { cameraId, state: 'ended', reason });
}

function metricTier(live: Live): (typeof CAMERA_METRIC_TIERS)[number] | null {
  return (CAMERA_METRIC_TIERS as readonly string[]).includes(live.tier)
    ? (live.tier as (typeof CAMERA_METRIC_TIERS)[number])
    : null;
}

function countResult(
  hub: SignalHub,
  live: Live,
  result: 'live' | 'declined' | 'no_camera' | 'expired' | 'error',
): void {
  const tier = metricTier(live);
  if (tier) hub.ctx.metrics.cameraSessions.inc({ tier, result });
}

/** `ia_camera_sessions_total{result="expired"}` for a link that expired unused (REST side, any node). */
export function countExpired(hub: SignalHub, tier: string): void {
  if ((CAMERA_METRIC_TIERS as readonly string[]).includes(tier))
    hub.ctx.metrics.cameraSessions.inc({ tier: tier as (typeof CAMERA_METRIC_TIERS)[number], result: 'expired' });
}

// ---------- end ----------

/**
 * Ends the session's camera (owner node): `camera.closed` to the phone, `camera.state ended` to the Assist and a P1
 * Desk, the participant row closed, `camera.ended` (and the camera's `recording.server_stopped`) chained, presence
 * cleared. Idempotent.
 */
export async function endCamera(hub: SignalHub, live: Live, by: CameraStopReason): Promise<void> {
  const cam = live.camera;
  if (!cam) return;
  const { ctx } = hub;
  live.camera = null;
  const rt = runtime(hub);
  const x = rt.extra.get(live.id);
  rt.extra.delete(live.id);
  const durationMs = cam.startedAt !== null ? Math.max(0, Date.now() - cam.startedAt) : null;
  const phone = hub.conn(cam.connId);
  if (phone) {
    phone.send({ t: 'camera.closed', reason: by });
    phone.close(WS_CLOSE.normal, 'camera ended');
  }
  pushState(hub, live, { cameraId: cam.cameraId, state: 'ended', reason: by });
  await clearCameraSession(ctx.presence, live.id, cam.cameraId);
  if (cam.startedAt === null) {
    if (by === 'declined') countResult(hub, live, 'declined');
    else if (by === 'no_camera' || by === 'permission_denied') countResult(hub, live, 'no_camera');
    else if (by === 'error' || by === 'disconnected') countResult(hub, live, 'error');
  }
  const org = await orgOf(hub, live.orgId);
  await ctx.db.transaction(async (tx) => {
    await closeParticipants(tx, live.id, 'camera');
    if (x?.recorderId)
      await writeAudit(ctx, tx, org, {
        sessionId: live.id,
        actor: recorderActor(x.recorderId),
        action: 'recording.server_stopped',
        data: {
          recorderId: x.recorderId,
          reason: by === 'session_ended' ? 'session_ended' : 'track_ended',
          cameraId: cam.cameraId,
        },
      });
    await writeAudit(ctx, tx, org, {
      sessionId: live.id,
      actor: systemActor,
      action: 'camera.ended',
      data: { cameraId: cam.cameraId, by, durationMs },
    });
  });
}

// ---------- hello ----------

function refuseLink(conn: Conn, re: string | undefined): void {
  conn.error('camera_link_invalid', 'this camera link is not valid any more; ask the technician for a new one', re);
  conn.close(WS_CLOSE.forbidden, 'camera link invalid');
}

/** `camera.hello { code } | { resumeKey }` (section 6.4). */
export async function handleCameraHello(hub: SignalHub, conn: Conn, msg: SignalOf<'camera.hello'>): Promise<void> {
  const { ctx } = hub;
  const lim = await ctx.limiter.hit(`camera-hello:${conn.ip}`, 20, 60_000);
  if (!lim.allowed) {
    ctx.metrics.rateLimited.inc();
    conn.error('rate_limited', 'too many camera connections; wait a minute', msg.id, {
      retryAfterSec: lim.retryAfterSec,
    });
    return conn.close(WS_CLOSE.rateLimited, 'rate limited');
  }
  if (msg.resumeKey !== undefined) return resumeCamera(hub, conn, msg.resumeKey, msg.id);
  const code = normaliseCameraCode(msg.code ?? '');
  if (!code) return refuseLink(conn, msg.id);
  const codeHash = cameraCodeHash(code);
  // Peek first: a session owned by another node must not burn the single-use code here.
  const peek = await peekCameraLink(ctx.presence, codeHash);
  if (!peek) return refuseLink(conn, msg.id);
  if (!hub.live.has(peek.sessionId) && hub.bridge.on) {
    const s = await getSession(ctx.db, peek.sessionId);
    if (s && s.nodeId !== ctx.config.nodeId && (await ctx.presence.isNodeAlive(s.nodeId))) {
      ctx.log.warn({ sessionId: peek.sessionId }, 'camera hello reached a node that does not own the session');
      conn.error('bad_state', 'the camera could not reach this support session; open the link again', msg.id);
      return conn.close(WS_CLOSE.forbidden, 'not the session owner');
    }
  }
  const link = await consumeCameraLink(ctx.presence, codeHash);
  if (!link) return refuseLink(conn, msg.id);
  const live = hub.live.get(link.sessionId);
  const s = await getSession(ctx.db, link.sessionId);
  const sess = await readCameraSession(ctx.presence, link.sessionId);
  if (!live || !s || s.state !== 'active' || live.state !== 'active' || !sess || sess.cameraId !== link.cameraId) {
    if (sess && sess.cameraId === link.cameraId) await clearCameraSession(ctx.presence, link.sessionId, link.cameraId);
    return refuseLink(conn, msg.id);
  }
  if (live.camera) {
    conn.error('camera_busy', 'this session already has a phone camera', msg.id);
    return conn.close(WS_CLOSE.forbidden, 'camera busy');
  }
  const org = await orgOf(hub, s.orgId);
  // Phase F section 5.3 step 1: no camera joins an org whose erasure is executing (`org_erasing`, 4403).
  if (refuseIfOrgErasing(conn, org, msg.id)) return;
  const resumeKey = base64urlEncode(randomBytes(32));
  conn.side = 'camera';
  live.camera = { cameraId: link.cameraId, connId: conn.id, startedAt: null, resumeKeyHash: sha256Hex(resumeKey) };
  const recording: CameraRecording = {
    server: serverRecordingInForce(live),
    console: consoleRecords(live, s.recordingStarted),
  };
  runtime(hub).extra.set(live.id, {
    cameraId: link.cameraId,
    resumeUntil: null,
    recorderConnId: null,
    recorderId: null,
    recording,
    consoleRecording: recording.console,
    consolePolledAt: Date.now(),
    busy: false,
  });
  await writeCameraSession(
    ctx.presence,
    live.id,
    { cameraId: link.cameraId, codeHash, state: 'connected' },
    CAMERA_SESSION_CONNECTED_TTL_SEC,
  );
  await replaceParticipant(ctx.db, {
    sessionId: live.id,
    role: 'camera',
    label: 'Phone camera',
    connectionId: conn.id,
  });
  conn.send(await helloOk(hub, live, s.assistUserId, org, resumeKey, recording, msg.id));
  pushState(hub, live, { cameraId: link.cameraId, state: 'joined' });
  ensureWatcher(hub);
}

async function helloOk(
  hub: SignalHub,
  live: Live,
  assistUserId: string,
  org: Pick<OrgRow, 'name' | 'branding'>,
  resumeKey: string,
  recording: CameraRecording,
  id: string | undefined,
): Promise<Record<string, unknown>> {
  const { ctx } = hub;
  const cam = live.camera!;
  const tech = refOf(await userRefs(ctx.db, [assistUserId]), assistUserId);
  return {
    t: 'camera.hello.ok',
    ...re(id),
    cameraId: cam.cameraId,
    sessionId: live.id,
    org: { displayName: (org.branding?.displayName || org.name).slice(0, 200) },
    technician: { name: tech.name.slice(0, 200) },
    iceServers: buildIceServers(ctx.config, `camera:${cam.cameraId}`).iceServers,
    resumeKey,
    limits: { maxBitrateKbps: LIMITS.cameraMaxBitrateKbps },
    recording,
  };
}

/** `camera.hello { resumeKey }`: the phone's socket dropped; within `cameraResumeSec` it takes the camera back. */
async function resumeCamera(hub: SignalHub, conn: Conn, resumeKey: string, id: string | undefined): Promise<void> {
  const { ctx } = hub;
  const hash = sha256Hex(resumeKey);
  const rt = runtime(hub);
  let live: Live | null = null;
  for (const l of hub.live.values()) if (l.camera?.resumeKeyHash === hash) live = l;
  const cam = live?.camera;
  const x = live ? rt.extra.get(live.id) : undefined;
  const now = Date.now();
  if (
    !live ||
    !cam ||
    !x ||
    live.state === 'ended' ||
    (cam.connId === null && x.resumeUntil !== null && now > x.resumeUntil)
  )
    return refuseLink(conn, id);
  const old = hub.conn(cam.connId);
  if (old && old.id !== conn.id) old.close(WS_CLOSE.forbidden, 'camera resumed elsewhere');
  const s = await getSession(ctx.db, live.id);
  if (!s || s.state === 'ended') return refuseLink(conn, id);
  const org = await orgOf(hub, s.orgId);
  if (refuseIfOrgErasing(conn, org, id)) return;
  const next = base64urlEncode(randomBytes(32));
  conn.side = 'camera';
  cam.connId = conn.id;
  cam.resumeKeyHash = sha256Hex(next);
  x.resumeUntil = null;
  await replaceParticipant(ctx.db, {
    sessionId: live.id,
    role: 'camera',
    label: 'Phone camera',
    connectionId: conn.id,
  });
  conn.send(await helloOk(hub, live, s.assistUserId, org, next, x.recording, id));
  if (cam.startedAt !== null) pushState(hub, live, { cameraId: cam.cameraId, state: 'live' });
  ensureWatcher(hub);
}

// ---------- ready / stop ----------

/** `camera.ready` after the phone's track starts (chains `camera.started`). */
export async function handleCameraReady(hub: SignalHub, conn: Conn, msg: SignalOf<'camera.ready'>): Promise<void> {
  const { ctx } = hub;
  const live = liveOfConn(hub, conn);
  const cam = live?.camera;
  if (!live || !cam || cam.cameraId !== msg.cameraId) return conn.error('forbidden', 'not this session camera', msg.id);
  if (cam.startedAt !== null) return; // a resumed phone repeats it: once per camera
  if (live.state !== 'active') return conn.error('consent_required', 'the session is not active', msg.id);
  const s = await getSession(ctx.db, live.id);
  if (!s) return;
  cam.startedAt = Date.now();
  const org = await orgOf(hub, live.orgId);
  await writeAudit(ctx, ctx.db, org, {
    sessionId: live.id,
    actor: deskActor(s.deskRef),
    action: 'camera.started',
    data: { cameraId: cam.cameraId, width: msg.width, height: msg.height, facing: msg.facing },
  });
  countResult(hub, live, 'live');
  pushState(hub, live, { cameraId: cam.cameraId, state: 'live' });
  await reconcileRecorder(hub, live);
}

/** `camera.stop { cameraId, reason }` from the phone. */
export async function handleCameraStop(hub: SignalHub, conn: Conn, msg: SignalOf<'camera.stop'>): Promise<void> {
  const live = liveOfConn(hub, conn);
  if (!live || live.camera?.cameraId !== msg.cameraId)
    return conn.error('forbidden', 'not this session camera', msg.id);
  await endCamera(hub, live, PHONE_REASONS.has(msg.reason) ? msg.reason : 'phone_stopped');
}

// ---------- webrtc ----------

/**
 * `webrtc.*` between the camera and the session's Assist (section 6.4): from the camera side to `live.assistConnId`
 * with `peer: 'camera'` (and `sessionId` = the camera id, see the header); from the Assist with `peer: 'camera'` to
 * `live.camera.connId`, without `peer`. Called by `handleWebrtc` only after the sender was authorised for the session
 * and the session is `active`.
 */
export async function routeCameraWebrtc(hub: SignalHub, conn: Conn, live: Live, msg: WebrtcMsg): Promise<void> {
  const cam = live.camera;
  const { peer: _peer, ...rest } = msg;
  if (!cam) return conn.error('bad_state', 'this session has no phone camera', msg.id);
  if (conn.side === 'camera') {
    if (cam.connId !== conn.id) return conn.error('forbidden', 'not this session camera', msg.id);
    hub.conn(live.assistConnId)?.send({ ...rest, sessionId: cam.cameraId, peer: 'camera' });
    return;
  }
  if (conn.side === 'assist' && live.assistConnId === conn.id) {
    hub.conn(cam.connId)?.send(rest);
    return;
  }
  conn.error('forbidden', 'only the Assist exchanges media with the camera', msg.id);
}

/**
 * `webrtc.*` between the camera and the session's joined A.2 recorder (section 6.5a): the camera's `peer: 'recorder'`
 * frames to the recorder socket (tagged `peer: 'camera'`), and the recorder's `peer: 'camera'` frames to the camera
 * socket (tagged `peer: 'recorder'`); only after `recorder.camera` was sent to that recorder, nothing else.
 */
export async function routeCameraRecorderWebrtc(hub: SignalHub, conn: Conn, live: Live, msg: WebrtcMsg): Promise<void> {
  const cam = live.camera;
  const x = runtime(hub).extra.get(live.id);
  const { peer: _peer, ...rest } = msg;
  if (!cam || !x || x.recorderConnId === null || live.recorder.connId !== x.recorderConnId)
    return conn.error('consent_required', 'no recorder takes this camera', msg.id);
  if (conn.side === 'camera' && cam.connId === conn.id) {
    hub.conn(x.recorderConnId)?.send({ ...rest, peer: 'camera' });
    return;
  }
  if (conn.side === 'recorder' && conn.id === x.recorderConnId) {
    hub.conn(cam.connId)?.send({ ...rest, peer: 'recorder' });
    return;
  }
  conn.error('forbidden', 'only the camera and its recorder exchange this media', msg.id);
}

// ---------- the watcher ----------

/** `recorder.camera` to the joined recorder once the camera is live (and again after the recorder changed). */
async function reconcileRecorder(hub: SignalHub, live: Live): Promise<void> {
  const cam = live.camera;
  const x = runtime(hub).extra.get(live.id);
  if (!cam || !x) return;
  const r = live.recorder;
  if (x.recorderConnId !== null && (r.connId !== x.recorderConnId || !hub.conn(x.recorderConnId))) {
    // The recorder that held the camera left: its camera recording ends with it.
    const recorderId = x.recorderId;
    x.recorderConnId = null;
    x.recorderId = null;
    if (recorderId) {
      const org = await orgOf(hub, live.orgId);
      await writeAudit(hub.ctx, hub.ctx.db, org, {
        sessionId: live.id,
        actor: recorderActor(recorderId),
        action: 'recording.server_stopped',
        data: { recorderId, reason: 'recorder_left', cameraId: cam.cameraId },
      });
    }
  }
  if (
    cam.startedAt === null ||
    x.recorderConnId !== null ||
    !serverRecordingInForce(live) ||
    !r.joined ||
    live.state !== 'active'
  )
    return;
  const rec = sessionRecorder(hub, live);
  if (!rec.conn || !rec.camera || rec.conn.id !== r.connId || r.recorderId === null) return;
  x.recorderConnId = rec.conn.id;
  x.recorderId = r.recorderId;
  rec.conn.send({ t: 'recorder.camera', sessionId: live.id, cameraId: cam.cameraId });
  const org = await orgOf(hub, live.orgId);
  await writeAudit(hub.ctx, hub.ctx.db, org, {
    sessionId: live.id,
    actor: recorderActor(r.recorderId),
    action: 'recording.server_started',
    data: {
      recorderId: r.recorderId,
      recordingMode: live.recordingMode === 'both' ? 'both' : 'server',
      cameraId: cam.cameraId,
    },
  });
}

async function watchOne(hub: SignalHub, live: Live, x: CameraExtra, now: number): Promise<void> {
  const cam = live.camera;
  if (!cam) return;
  if (live.state === 'ended' || hub.live.get(live.id) !== live) return endCamera(hub, live, 'session_ended');
  if (cam.connId !== null && !hub.conn(cam.connId)) {
    cam.connId = null;
    x.resumeUntil = now + cameraTiming.resumeMs;
  }
  if (cam.connId === null) {
    if (x.resumeUntil === null) x.resumeUntil = now + cameraTiming.resumeMs;
    if (now > x.resumeUntil) return endCamera(hub, live, 'disconnected');
    return;
  }
  await reconcileRecorder(hub, live);
  if (live.tier === 'p1_browser' && assistMayRecord(live.recordingMode) && now - x.consolePolledAt >= CONSOLE_POLL_MS) {
    x.consolePolledAt = now;
    const s = await getSession(hub.ctx.db, live.id);
    if (s) x.consoleRecording = consoleRecords(live, s.recordingStarted);
  }
  const next: CameraRecording = { server: serverRecordingInForce(live), console: x.consoleRecording };
  if (next.server !== x.recording.server || next.console !== x.recording.console) {
    x.recording = next;
    hub.conn(cam.connId)?.send({
      t: 'camera.state',
      cameraId: cam.cameraId,
      state: cam.startedAt !== null ? 'live' : 'joined',
      recording: next,
    });
  }
}

async function watch(hub: SignalHub): Promise<void> {
  const rt = runtime(hub);
  const now = Date.now();
  for (const [sessionId, x] of [...rt.extra]) {
    const live = hub.live.get(sessionId);
    if (!live || !live.camera || live.camera.cameraId !== x.cameraId) {
      // The live entry was evicted (or replaced) under the camera: nothing left to end on this node.
      if (!live?.camera) rt.extra.delete(sessionId);
      continue;
    }
    if (x.busy) continue;
    x.busy = true;
    try {
      await watchOne(hub, live, x, now);
    } finally {
      x.busy = false;
    }
  }
  if (rt.extra.size === 0 && rt.timer) {
    clearInterval(rt.timer);
    rt.timer = null;
  }
}

/** Test and REST hook: the camera of a session on this node, if any. */
export function localCamera(
  hub: SignalHub,
  sessionId: string,
): { live: Live; cameraId: string; started: boolean } | null {
  const live = hub.live.get(sessionId);
  if (!live?.camera) return null;
  return { live, cameraId: live.camera.cameraId, started: live.camera.startedAt !== null };
}

/** Whether the session's native Desk tier can carry a camera (P1, P3, P4; never P2, section 6.2d). */
export function cameraTierAllowed(tier: string): boolean {
  return tier === 'p1_browser' || isNativeTier(tier as Live['tier']);
}
