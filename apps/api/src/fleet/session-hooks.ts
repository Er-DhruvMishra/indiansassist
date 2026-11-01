/**
 * Phase D hooks into the C session paths (docs/specs/phase-d-contracts.md sections 3.5, 5.2b, 5.4, 6.2, 6.3):
 * `session.created.device`, `session.unattended_started` at active, the `maxUnattendedMinutes` cap, the declined local
 * approval (`consent_required`), in-place privileged mode, the P4 `desk.event` attestations (and the rule 6.2a
 * `session.local_user_arrived` push to the technician's console) and the `session.protections_released` entry when
 * the worker dies with input lock / privacy screen on.
 */
import {
  DESK_EVENT_P4_DATA,
  type AgentConsentLevel,
  type ApprovedBy,
  type DeskEventP4Action,
  type SessionEndReason,
  type SignalOf,
  type UnattendedPolicy,
} from '@indiansassist/shared';
import { getDevice, getSession, updateSession, type OrgRow, type SessionRow, type Tx } from '@indiansassist/db';
import { deskActor, systemActor, writeAudit } from '../lib/audit.js';
import { endSessionQuietly } from '../services/session-end.js';
import { clearTimer, setTimer, type Conn, type Live, type LiveAgent } from '../signal/conn.js';
import { pushAgentConsent } from '../signal/desk-p3.js';
import type { SignalHub } from '../signal/hub.js';
import { orgOf } from '../signal/messages.js';

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

/** Loads `live.p4.device` (`session.created.device`, rule 3.5b) once. */
export async function ensureP4Device(hub: SignalHub, live: Live): Promise<void> {
  if (!live.p4 || live.p4.device) return;
  const d = await getDevice(hub.ctx.db, live.p4.deviceId);
  if (d?.publicKey && d.keyId) live.p4.device = { id: d.id, name: d.name, keyId: d.keyId, publicKey: d.publicKey };
}

function policyOfSession(live: Live, s: SessionRow): UnattendedPolicy | null {
  return live.p4?.policy ?? ((s.unattendedPolicy as UnattendedPolicy | null) ?? null);
}

/**
 * Inside the consent transaction: `session.unattended_started { approvedBy, policySnapshot, reason }` for an
 * unattended session. `auto_grant` -> `policy`; `local_approval` -> what the worker reports (`local_user` by default,
 * `auto_after_timeout` when the countdown allowed it).
 */
export async function p4ConsentEntries(hub: SignalHub, tx: Tx, org: OrgRow, live: Live, s: SessionRow, reported: ApprovedBy | undefined): Promise<void> {
  if (s.unattended !== true) return;
  const policy = policyOfSession(live, s);
  if (!policy) return;
  const decision = live.p4?.decision ?? null;
  const approvedBy: ApprovedBy =
    decision === 'auto_grant' ? 'policy' : reported === 'auto_after_timeout' ? 'auto_after_timeout' : decision === 'local_approval' ? 'local_user' : (reported ?? 'policy');
  if (live.p4) live.p4.approvedBy = approvedBy;
  await writeAudit(hub.ctx, tx, org, {
    sessionId: s.id,
    actor: systemActor,
    action: 'session.unattended_started',
    data: { approvedBy, policySnapshot: policy, reason: live.p4?.reason ?? null },
  });
}

/** After active: the `maxUnattendedMinutes` cap of a policy-authorised session (section 6.1). */
export function p4OnActive(hub: SignalHub, live: Live): void {
  const p = live.p4;
  if (!p || !p.unattended || p.approvedBy !== 'policy' || !p.policy || p.policy.maxUnattendedMinutes <= 0) return;
  setTimer(live, 'policy-timeout', p.policy.maxUnattendedMinutes * 60_000, () => {
    void endSessionQuietly(hub.ctx, live.id, { reason: 'policy_timeout', actor: systemActor }).catch((err: unknown) =>
      hub.ctx.log.error({ err, sessionId: live.id }, 'policy timeout end failed'),
    );
  });
}

/** Section 6.2: a revoke before active is a declined / unanswered local approval or consent. */
export function p4ConsentRevokeReason(s: SessionRow): SessionEndReason {
  return s.state === 'consent_pending' ? 'consent_required' : 'consent_revoked';
}

/**
 * Rule 5.2b: the worker raises the level to `elevated` in place (privileged mode, no relaunch) after the policy /
 * approval check: `desk.consent_level { level: 'elevated', requested: true, opId }`. Refused when the effective policy
 * forbids privileged mode.
 */
export async function p4PrivilegedMode(
  hub: SignalHub,
  conn: Conn,
  live: Live,
  s: SessionRow,
  agent: LiveAgent,
  msg: SignalOf<'desk.consent_level'>,
): Promise<void> {
  const { ctx } = hub;
  const policy = policyOfSession(live, s);
  if (!policy?.allowPrivileged) return conn.error('bad_payload', 'the policy does not allow privileged mode', msg.id);
  if (!msg.opId) return conn.error('bad_payload', 'privileged mode needs the opId of the elevation request', msg.id);
  const opId = msg.opId;
  if (agent.level !== 'elevated') {
    const org = await orgOf(hub, s.orgId);
    await ctx.db.transaction(async (tx) => {
      await updateSession(tx, s.id, { consentLevel: 'elevated', elevation: 'admin' });
      const desk = deskActor(s.deskRef);
      await writeAudit(ctx, tx, org, { sessionId: s.id, actor: desk, action: 'elevation.granted', data: { opId, elevation: 'admin', claimed: true, mode: 'service' } });
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor: desk,
        action: 'consent.level_changed',
        data: { from: agent.level, to: 'elevated', requestedBy: 'assist', opId },
      });
    });
  }
  const level: AgentConsentLevel = 'elevated';
  live.agent = { ...agent, level, elevation: 'admin' };
  conn.send({ t: 'consent.level_ok', ...re(msg.id), sessionId: s.id, level, backstage: false, clipboard: agent.clipboard });
  pushAgentConsent(hub, live, live.agent);
}

/** The P4 `desk.event` attestations (section 13.3, actor `desk`). */
export async function p4DeskEvent(hub: SignalHub, conn: Conn, live: Live, s: SessionRow, msg: SignalOf<'desk.event'>): Promise<void> {
  const { ctx } = hub;
  const action = msg.action as DeskEventP4Action;
  if (s.state !== 'active' && s.state !== 'ended') return conn.error('bad_state', `session is ${s.state}`, msg.id);
  const r = DESK_EVENT_P4_DATA[action].safeParse(msg.data);
  if (!r.success) return conn.error('bad_payload', `invalid ${action} data`, msg.id);
  const data = r.data as Record<string, unknown>;
  const org = await orgOf(hub, s.orgId);
  const entry = await writeAudit(ctx, ctx.db, org, { sessionId: s.id, actor: deskActor(s.deskRef), action, data: data as never });
  if (live.p4) {
    if (action === 'input.lock_changed') live.p4.inputLock = data['locked'] === true;
    if (action === 'privacy.screen_changed') live.p4.privacyScreen = data['on'] === true;
    // Rule 6.2a: the maxUnattendedMinutes clock pauses once a present user chose Continue.
    if (action === 'session.local_user_arrived' && data['decision'] === 'continue') clearTimer(live, 'policy-timeout');
  }
  // Rule 6.2a: the console learns at once that someone is now at the device, and whether the session dropped to view.
  if (action === 'session.local_user_arrived') {
    hub.conn(live.assistConnId)?.send({
      t: 'session.local_user_arrived',
      sessionId: s.id,
      decision: data['decision'] as 'continue' | 'ended',
      levelDroppedTo: data['levelDroppedTo'] === 'view' ? 'view' : null,
    });
  }
  conn.send({ t: 'event.ok', ...re(msg.id), sessionId: s.id, entryId: entry.id });
}

/** Rule 5.4d: the worker's socket dropped while a protection was on (the OS released it with the process). */
export async function protectionsReleased(hub: SignalHub, live: Live): Promise<void> {
  const p = live.p4;
  if (!p || (!p.inputLock && !p.privacyScreen)) return;
  const data = { inputLock: p.inputLock, privacyScreen: p.privacyScreen };
  p.inputLock = false;
  p.privacyScreen = false;
  const s = await getSession(hub.ctx.db, live.id);
  if (!s) return;
  const org = await orgOf(hub, s.orgId);
  await writeAudit(hub.ctx, hub.ctx.db, org, { sessionId: s.id, actor: systemActor, action: 'session.protections_released', data });
}
