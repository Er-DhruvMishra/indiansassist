/**
 * The Phase A.2 server recorder on the signaling side (docs/specs/phase-a2-recorder.md sections 4-6):
 * `recorder.hello` (service token), assignment of sessions that need a recorder, `recorder.join` (third participant,
 * `recording.server_started`), `recorder.pause` on a Desk resume, `recorder.leave` / a lost recorder socket
 * (`recording.server_stopped`) and the `session.recording { source: 'server' }` pushes to the Desk and the Assist.
 */
import {
  isRegionServed,
  LIMITS,
  REGIONS,
  recorderActor,
  serverRecords,
  WS_CLOSE,
  type RecorderStopReason,
  type SignalOf,
} from '@indiansassist/shared';
import {
  closeParticipants,
  getSession,
  lockSession,
  markServerRecording,
  replaceParticipant,
  SessionAlreadyEndedError,
} from '@indiansassist/db';
import { writeAudit } from '../lib/audit.js';
import { recorderTokenOk } from '../lib/recorder-auth.js';
import { iso } from '../lib/time.js';
import { TokenBucket } from '../limiter.js';
import { clearTimer, setTimer, type Conn, type Live } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';
import { refuse } from './relay.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

export async function handleRecorderHello(hub: SignalHub, conn: Conn, msg: SignalOf<'recorder.hello'>): Promise<void> {
  const { ctx } = hub;
  const served = isRegionServed(msg.region, ctx.config.servedRegions);
  if (!recorderTokenOk(ctx.config, msg.token) || !served || conn.extensionOrigin) {
    const lim = await ctx.limiter.hit(`recorder-hello:${conn.ip}`, 10, 60_000);
    ctx.log.warn({ connectionId: conn.id, recorderId: msg.recorderId, served }, 'recorder hello refused');
    if (!lim.allowed) {
      ctx.metrics.rateLimited.inc();
      conn.error('rate_limited', 'too many failed recorder hellos', msg.id, { retryAfterSec: lim.retryAfterSec });
      return conn.close(WS_CLOSE.rateLimited, 'rate limited');
    }
    conn.error('forbidden', 'recorder not allowed', msg.id);
    return conn.close(WS_CLOSE.forbidden, 'forbidden');
  }
  conn.side = 'recorder';
  conn.recorder = { recorderId: msg.recorderId, maxSessions: msg.maxSessions ?? LIMITS.recorderMaxSessionsDefault };
  conn.bucket = new TokenBucket(LIMITS.recorderFramesPerSec, LIMITS.recorderFramesBurst);
  ctx.metrics.recorderConnections.inc();
  ctx.log.info({ connectionId: conn.id, recorderId: msg.recorderId }, 'recorder connected');
  const regions = ctx.config.servedRegions.length > 0 ? ctx.config.servedRegions : [...REGIONS];
  conn.send({ t: 'recorder.hello.ok', ...re(msg.id), connectionId: conn.id, nodeId: ctx.config.nodeId, regions });
  for (const live of hub.live.values()) if (needsRecorder(live)) await assignRecorder(hub, live);
}

/** An `active` P1 session whose policy asks for the server recorder and that has none (section 6 A1). */
export function needsRecorder(live: Live): boolean {
  const r = live.recorder;
  return (
    live.state === 'active' &&
    live.tier === 'p1_browser' &&
    serverRecords(live.recordingMode) &&
    !r.started &&
    r.connId === null &&
    r.assignedConnId === null
  );
}

/** Helloed recorder sockets of this node (never bridged, H5). */
function recorderConns(hub: SignalHub): Conn[] {
  return [...hub.conns.values()].filter((c) => c.side === 'recorder' && c.recorder !== null && !c.closed);
}

function loadOf(hub: SignalHub, connId: string): number {
  let n = 0;
  for (const l of hub.live.values())
    if (l.state !== 'ended' && (l.recorder.connId === connId || l.recorder.assignedConnId === connId)) n++;
  return n;
}

/**
 * Sends `recorder.assign` to the least loaded recorder socket (A1), or, with `resume`, to the session's own paused
 * recorder (A3). Returns false when no socket was available.
 */
export async function assignRecorder(hub: SignalHub, live: Live, resume = false): Promise<boolean> {
  const { ctx } = hub;
  const r = live.recorder;
  let target: Conn | null;
  if (resume) {
    const c = hub.localConn(r.connId ?? '');
    target = c?.side === 'recorder' ? c : null;
  } else {
    const candidates = recorderConns(hub)
      .filter((c) => !r.tried.has(c.id))
      .map((c) => ({ c, load: loadOf(hub, c.id) }))
      .filter((x) => x.load < x.c.recorder!.maxSessions)
      .sort((a, b) => a.load - b.load || a.c.openedAt - b.c.openedAt);
    target = candidates[0]?.c ?? null;
  }
  if (!target) {
    if (!resume) {
      ctx.metrics.recorderAssignFailures.inc();
      ctx.log.warn({ sessionId: live.id }, 'no server recorder available for this session');
    }
    return false;
  }
  const s = await getSession(ctx.db, live.id);
  if (!s || s.state !== 'active' || !serverRecords(live.recordingMode)) return false;
  const timeout = ctx.timing.recorderJoinTimeoutMs;
  r.assignedConnId = target.id;
  r.assignedUntil = Date.now() + timeout;
  r.tried.add(target.id);
  r.resume = resume;
  target.send({
    t: 'recorder.assign',
    sessionId: s.id,
    orgId: s.orgId,
    region: s.region,
    tier: s.tier,
    recordingMode: live.recordingMode,
    resume,
    deadlineAt: iso(new Date(r.assignedUntil)),
  });
  const assigned = target.id;
  setTimer(live, 'recorder-assign', timeout, () => {
    if (r.assignedConnId !== assigned) return;
    r.assignedConnId = null;
    ctx.log.warn({ sessionId: live.id, connectionId: assigned }, 'recorder did not join in time');
    if (!resume && r.tried.size < LIMITS.recorderAssignAttempts && needsRecorder(live))
      void assignRecorder(hub, live).catch((err: unknown) =>
        ctx.log.error({ err, sessionId: live.id }, 'recorder re-assign failed'),
      );
    else if (!resume) ctx.metrics.recorderAssignFailures.inc();
  });
  return true;
}

/** `desk.consent granted`: first activation assigns a recorder, a re-consent resumes the paused one (A1 / A3). */
export async function onSessionActive(hub: SignalHub, live: Live): Promise<void> {
  const r = live.recorder;
  if (live.tier !== 'p1_browser' || !serverRecords(live.recordingMode)) return;
  if (r.connId !== null && !r.joined && !r.stopped) {
    await assignRecorder(hub, live, true);
    return;
  }
  r.tried.clear();
  if (needsRecorder(live)) await assignRecorder(hub, live);
}

/** `session.recording { source: 'server' }` to the Desk and the Assist of a session (S1 / S3). */
export function pushServerRecording(hub: SignalHub, live: Live, recording: boolean): void {
  const frame = { t: 'session.recording', sessionId: live.id, recording, source: 'server' };
  hub.conn(live.deskConnId)?.send(frame);
  hub.conn(live.assistConnId)?.send(frame);
}

export async function handleRecorderJoin(hub: SignalHub, conn: Conn, msg: SignalOf<'recorder.join'>): Promise<void> {
  const { ctx } = hub;
  const live = hub.live.get(msg.sessionId);
  const r = live?.recorder;
  if (!live || !r || r.assignedConnId !== conn.id) return refuse(hub, conn, msg.sessionId, msg.t, msg.id);
  if (Date.now() > r.assignedUntil) return conn.error('bad_state', 'the assignment expired', msg.id);
  if (live.state !== 'active') return conn.error('consent_required', 'the session is not active', msg.id);
  const recorderId = conn.recorder!.recorderId;
  const org = await orgOf(hub, live.orgId);
  const wasCounted = r.connId !== null;
  await ctx.db.transaction(async (tx) => {
    const locked = await lockSession(tx, live.id); // session row before its participant rows (lock order)
    if (!locked || locked.state !== 'active') throw new SessionAlreadyEndedError('ended');
    if (r.connId !== conn.id)
      await replaceParticipant(tx, { sessionId: live.id, role: 'recorder', label: 'recorder', connectionId: conn.id });
    if (await markServerRecording(tx, live.id)) {
      await writeAudit(ctx, tx, org, {
        sessionId: live.id,
        actor: recorderActor(recorderId),
        action: 'recording.server_started',
        data: { recorderId, recordingMode: live.recordingMode === 'both' ? 'both' : 'server' },
      });
    }
  });
  clearTimer(live, 'recorder-assign');
  r.assignedConnId = null;
  r.connId = conn.id;
  r.recorderId = recorderId;
  r.joined = true;
  r.started = true;
  if (!wasCounted) ctx.metrics.recorderSessions.inc();
  conn.send({ t: 'recorder.joined', ...re(msg.id), sessionId: live.id, resume: r.resume });
  pushServerRecording(hub, live, true);
}

/** Desk resume took the session out of `active` (A 7.5): the recorder closes its peer connection, keeps its file. */
export function pauseRecorder(hub: SignalHub, live: Live): void {
  const r = live.recorder;
  if (r.assignedConnId !== null) {
    clearTimer(live, 'recorder-assign');
    r.assignedConnId = null;
  }
  if (r.connId === null || !r.joined) return;
  r.joined = false;
  hub.conn(r.connId)?.send({ t: 'recorder.pause', sessionId: live.id, reason: 'consent_pending' });
}

export async function handleRecorderLeave(hub: SignalHub, conn: Conn, msg: SignalOf<'recorder.leave'>): Promise<void> {
  const live = hub.live.get(msg.sessionId);
  if (!live || live.recorder.connId !== conn.id) return refuse(hub, conn, msg.sessionId, msg.t, msg.id);
  await stopRecorder(hub, live, msg.reason);
}

/** `recording.server_stopped` (once, after a start), closes the participant row and tells both sides (S3). */
export async function stopRecorder(hub: SignalHub, live: Live, reason: RecorderStopReason): Promise<void> {
  const { ctx } = hub;
  const r = live.recorder;
  if (r.connId === null) return;
  const recorderId = r.recorderId;
  const write = r.started && !r.stopped && recorderId !== null;
  r.stopped = true;
  r.connId = null;
  r.joined = false;
  ctx.metrics.recorderSessions.dec();
  if (write) {
    const org = await orgOf(hub, live.orgId);
    await ctx.db.transaction(async (tx) => {
      await lockSession(tx, live.id);
      await closeParticipants(tx, live.id, 'recorder');
      await writeAudit(ctx, tx, org, {
        sessionId: live.id,
        actor: recorderActor(recorderId),
        action: 'recording.server_stopped',
        data: { recorderId, reason },
      });
    });
  }
  if (live.state !== 'ended') pushServerRecording(hub, live, false);
}

/** A recorder socket closed: withdraw its assignments (re-assign elsewhere) and stop its sessions (`recorder_left`). */
export async function onRecorderClosed(hub: SignalHub, conn: Conn): Promise<void> {
  const { ctx } = hub;
  ctx.metrics.recorderConnections.dec();
  for (const live of [...hub.live.values()]) {
    const r = live.recorder;
    if (r.assignedConnId === conn.id) {
      clearTimer(live, 'recorder-assign');
      r.assignedConnId = null;
      if (!r.resume && r.tried.size < LIMITS.recorderAssignAttempts && needsRecorder(live))
        await assignRecorder(hub, live);
    }
    if (r.connId === conn.id && live.state !== 'ended') await stopRecorder(hub, live, 'recorder_left');
  }
}

/**
 * After a session ended: `session.ended` to its recorder (finalise and upload). If the end ran on another node the
 * owner had no chance to write `recording.server_stopped` inside the end transaction, so it is appended here.
 */
export async function recorderOnEnded(hub: SignalHub, live: Live, endedMsg: Record<string, unknown>): Promise<void> {
  const r = live.recorder;
  if (r.assignedConnId !== null) {
    clearTimer(live, 'recorder-assign');
    r.assignedConnId = null;
  }
  if (r.connId === null) return;
  hub.conn(r.connId)?.send(endedMsg);
  if (!r.stopped) await stopRecorder(hub, live, 'session_ended');
  else {
    r.connId = null;
    r.joined = false;
    hub.ctx.metrics.recorderSessions.dec();
  }
}
