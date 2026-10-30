/**
 * P3 consent on the signaling side (docs/specs/phase-c-contracts.md sections 3.3, 3.4, 3.6 M5): validation of
 * `desk.consent.native`, the P3 branch of `desk.consent_level` (family rule: only `view` / `control`, never
 * `elevated`, which only a hand-over sets), `desk.consent_clipboard` and `desk.consent_monitors`, each audited and
 * mirrored to the Assist as `consent.changed`.
 */
import { isAgentConsentLevel, type AgentConsentLevel, type PackageTier, type SignalOf } from '@indiansassist/shared';
import { getSession, updateSession, type SessionRow } from '@indiansassist/db';
import { deskActor, writeAudit } from '../lib/audit.js';
import { agentOfRow, type Conn, type Live, type LiveAgent } from './conn.js';
import type { SignalHub } from './hub.js';
import { orgOf } from './messages.js';
import { authorizeSession } from './relay.js';

type NativeGrant = SignalOf<'desk.consent'>['native'];

/** `desk.consent granted` for P3: the native consent to store, or the `bad_payload` message (section 3.4). */
export function checkNativeGrant(
  tier: PackageTier,
  surface: string | undefined,
  native: NativeGrant,
): { ok: true; agent: LiveAgent | null } | { ok: false; message: string } {
  if (tier !== 'p3_portable')
    return native === undefined ? { ok: true, agent: null } : { ok: false, message: 'native consent is only valid in P3 sessions' };
  if (!native) return { ok: false, message: 'a P3 session needs native: { level, monitors, clipboard }' };
  if (surface !== 'monitor') return { ok: false, message: 'a P3 session shares monitors (surface: monitor)' };
  if (native.level === 'elevated') return { ok: false, message: 'elevated is reached only through elevation' };
  return { ok: true, agent: { level: native.level, monitors: native.monitors.length, clipboard: native.clipboard, elevation: 'user' } };
}

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

/** `consent.changed` for a P3 session (the console reads the level only from this message). */
export function pushAgentConsent(hub: SignalHub, live: Live, a: LiveAgent): void {
  hub.conn(live.assistConnId)?.send({
    t: 'consent.changed',
    sessionId: live.id,
    state: 'granted',
    surface: 'monitor',
    level: a.level,
    monitors: a.monitors,
    clipboard: a.clipboard,
  });
}

/** The live P3 session in `active` this Desk socket is the participant of, else an error reply and null. */
async function activeP3(hub: SignalHub, conn: Conn, sessionId: string, t: string, reId: string | undefined) {
  const live = await authorizeSession(hub, conn, sessionId, t, reId);
  if (!live) return null;
  const s = await getSession(hub.ctx.db, sessionId);
  if (!s || s.state !== 'active') {
    conn.error('bad_state', `${t} needs an active session`, reId);
    return null;
  }
  if (s.tier !== 'p3_portable') {
    conn.error('bad_state', `${t} exists in P3 sessions only`, reId);
    return null;
  }
  const agent: LiveAgent = live.agent ?? agentOfRow(s) ?? { level: 'view', monitors: 1, clipboard: false, elevation: 'user' };
  return { live, s, agent };
}

/** The P3 branch of `desk.consent_level` (called by desk-consent.ts after the tier check). */
export async function p3ConsentLevel(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.consent_level'>): Promise<void> {
  const { ctx } = hub;
  const a = await activeP3(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!a) return;
  const { live, s, agent } = a;
  if (!isAgentConsentLevel(msg.level) || msg.level === 'elevated')
    return conn.error('bad_payload', 'a P3 Desk sets view or control; elevated is reached only through elevation', msg.id);
  const to: AgentConsentLevel = msg.level;
  const requested = msg.requested === true;
  if (agent.level !== to || requested) {
    const org = await orgOf(hub, s.orgId);
    await ctx.db.transaction(async (tx) => {
      await updateSession(tx, s.id, { consentLevel: to });
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor: deskActor(s.deskRef),
        action: 'consent.level_changed',
        data: { from: agent.level, to, requestedBy: requested ? 'assist' : 'desk', ...(msg.opId ? { opId: msg.opId } : {}) },
      });
    });
  }
  live.agent = { ...agent, level: to };
  conn.send({ t: 'consent.level_ok', ...re(msg.id), sessionId: s.id, level: to, backstage: false, clipboard: agent.clipboard });
  pushAgentConsent(hub, live, live.agent);
}

export async function handleDeskConsentClipboard(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.consent_clipboard'>): Promise<void> {
  const a = await activeP3(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!a) return;
  const { live, s, agent } = a;
  if (agent.clipboard !== msg.clipboard) await changeRow(hub, s, { consentClipboard: msg.clipboard }, 'consent.clipboard_changed', { from: agent.clipboard, to: msg.clipboard });
  live.agent = { ...agent, clipboard: msg.clipboard };
  conn.send({ t: 'consent.level_ok', ...re(msg.id), sessionId: s.id, level: agent.level, backstage: false, clipboard: msg.clipboard });
  pushAgentConsent(hub, live, live.agent);
}

export async function handleDeskConsentMonitors(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.consent_monitors'>): Promise<void> {
  const a = await activeP3(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!a) return;
  const { live, s, agent } = a;
  const to = msg.monitors.length;
  if (agent.monitors !== to) await changeRow(hub, s, { consentMonitors: to }, 'consent.monitors_changed', { from: agent.monitors, to });
  live.agent = { ...agent, monitors: to };
  conn.send({ t: 'consent.level_ok', ...re(msg.id), sessionId: s.id, level: agent.level, backstage: false, clipboard: agent.clipboard });
  pushAgentConsent(hub, live, live.agent);
}

async function changeRow(
  hub: SignalHub,
  s: SessionRow,
  patch: { consentClipboard?: boolean; consentMonitors?: number },
  action: 'consent.clipboard_changed' | 'consent.monitors_changed',
  data: { from: boolean | number; to: boolean | number },
): Promise<void> {
  const { ctx } = hub;
  const org = await orgOf(hub, s.orgId);
  await ctx.db.transaction(async (tx) => {
    await updateSession(tx, s.id, patch);
    await writeAudit(ctx, tx, org, { sessionId: s.id, actor: deskActor(s.deskRef), action, data });
  });
}
