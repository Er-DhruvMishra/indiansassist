/**
 * Phase D: opening a session to a device (docs/specs/phase-d-contracts.md section 3.5, 6.2). Checks in order: seat
 * tier covers `p4_installed`, the device is online (`409 device_offline`, hint: wake), it has no live session
 * (`409 device_busy { sessionId }`), then the section 6.2 decision. In one transaction the token-less session row
 * (`device_id`, `unattended`, the policy snapshot, recording raised to at least `server` when required),
 * `session.knock` (system) and `session.accepted` (user); then a worker credential is minted and
 * `device.session_open` pushed to the device through the node holding its socket.
 */
import { decideDeviceSession, tierWithin, type ConsentDecision, type RecordingMode } from '@indiansassist/shared';
import {
  createSession,
  findOpenSessionByDevice,
  getSeatByUser,
  isUniqueViolation,
  transitionSession,
  type DeviceRow,
} from '@indiansassist/db';
import type { AppContext } from '../context.js';
import { fail, HttpError } from '../errors.js';
import { systemActor, userActor, writeAudit } from '../lib/audit.js';
import type { Principal } from '../plugins/auth.js';
import { ensureLive, startConsentTimer } from '../signal/messages.js';
import { effectivePolicy, featuresOf, getDevicePresence, groupOf, interactiveOf, isDeviceOnline } from './common.js';
import { mintWorkerCredential } from './worker.js';

/** Phase F rule 8.4f, verbatim. */
export const PRELOGIN_UNSUPPORTED_TEXT =
  'Nobody is signed in to this Linux computer. IndiansAssist can connect only to a signed-in desktop session.';

/** A.2 recorder availability as seen from this node: a helloed recorder socket and a Desk that answers it. */
function recorderAvailable(ctx: AppContext, d: DeviceRow): boolean {
  const recorders = [...ctx.hub.conns.values()].some((c) => c.side === 'recorder' && !c.closed);
  return recorders && featuresOf(d).includes('recorder');
}

function raisedRecording(mode: RecordingMode, required: boolean): RecordingMode {
  if (!required) return mode;
  return mode === 'server' || mode === 'both' ? mode : mode === 'assist_only' ? 'both' : 'server';
}

export async function openDeviceSession(
  ctx: AppContext,
  p: Principal,
  d: DeviceRow,
  body: { unattended: boolean; reason?: string | undefined },
): Promise<{ sessionId: string; decision: ConsentDecision }> {
  const seat = await getSeatByUser(ctx.db, p.user.id);
  if (!seat || !seat.active || !tierWithin('p4_installed', seat.tier)) fail('tier_not_licensed', 'your seat does not include p4_installed');
  if (d.status !== 'enrolled') fail('device_offline', `the device is ${d.status}`);
  const presence = await getDevicePresence(ctx, d.id);
  if (!presence || !(await isDeviceOnline(ctx, d.id))) fail('device_offline', 'the device is offline', { hint: 'POST /api/v1/devices/:id/wake' });
  const open = await findOpenSessionByDevice(ctx.db, d.id);
  if (open) fail('device_busy', 'the device already has a live session', { sessionId: open.id });
  // Phase F rule 8.4f: a Linux device reaches only a signed-in desktop session; the greeter is out of scope, so
  // nobody signed in is refused whatever `allowLogonScreen` says.
  if (d.platform === 'linux' && interactiveOf(d)?.state === 'none') fail('prelogin_unsupported', PRELOGIN_UNSUPPORTED_TEXT);
  const policy = effectivePolicy(d, await groupOf(ctx, d), p.org);
  const verdict = decideDeviceSession({ unattended: body.unattended, policy, interactive: interactiveOf(d), recorderAvailable: recorderAvailable(ctx, d) });
  if (verdict.error) {
    const msg: Record<string, string> = {
      nobody_present: 'nobody is at the device; an attended session needs a person to consent',
      unattended_denied: 'the policy of this device denies unattended access',
      approval_required: 'this group requires someone at the device to approve',
      outside_policy_window: 'unattended access is outside the allowed hours of this device',
      prelogin_not_permitted: 'nobody is logged on and the policy does not allow the sign-in screen',
      recorder_required: 'the policy requires a server recording and no recorder can be assigned',
    };
    fail(verdict.error, msg[verdict.error] ?? verdict.error);
  }
  const decision = verdict.decision!;
  const reason = body.reason ?? null;
  const recordingMode = raisedRecording(p.org.recordingMode, policy.recordingRequired);
  let row;
  try {
    row = await ctx.db.transaction(async (tx) => {
      const s = await createSession(tx, {
        orgId: p.org.id,
        tokenId: null,
        deviceId: d.id,
        assistUserId: p.user.id,
        deskRef: presence!.connectionId,
        deskLabel: d.name,
        tier: 'p4_installed',
        region: p.org.dataRegion,
        nodeId: ctx.config.nodeId,
        unattended: body.unattended,
        unattendedPolicy: { ...policy },
      });
      await writeAudit(ctx, tx, p.org, { sessionId: s.id, actor: systemActor, action: 'session.knock', data: { deviceId: d.id, keyId: d.keyId! } });
      await transitionSession(tx, s.id, 'accepted', { from: 'knocked', set: { recordingMode } });
      await writeAudit(ctx, tx, p.org, {
        sessionId: s.id,
        actor: userActor(p.user),
        action: 'session.accepted',
        reason,
        data: { deviceId: d.id, unattended: body.unattended, reason, onBehalfOf: null },
      });
      return transitionSession(tx, s.id, 'consent_pending', {
        from: 'accepted',
        set: { consentDeadlineAt: new Date(Date.now() + ctx.timing.consentTimeoutMs) },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, 'session_device_open_unique')) {
      const cur = await findOpenSessionByDevice(ctx.db, d.id);
      throw new HttpError('device_busy', 'the device already has a live session', cur ? { sessionId: cur.id } : undefined);
    }
    throw err;
  }
  const live = ensureLive(ctx.hub, row);
  if (live.p4) {
    live.p4.decision = decision;
    live.p4.reason = reason;
    live.p4.policy = policy;
    if (d.publicKey && d.keyId) live.p4.device = { id: d.id, name: d.name, keyId: d.keyId, publicKey: d.publicKey };
  }
  startConsentTimer(ctx.hub, live);
  const cred = await mintWorkerCredential(ctx.hub, { sessionId: row.id, deviceId: d.id, gen: 0 });
  await ctx.hub.devices.push(d.id, {
    t: 'device.session_open',
    sessionId: row.id,
    assist: { name: p.user.name },
    reason,
    unattended: body.unattended,
    decision,
    policy,
    recordingMode,
    workerCredential: cred.workerCredential,
    workerCredentialExpiresAt: cred.expiresAt,
  });
  return { sessionId: row.id, decision };
}
