/**
 * P2 consent on the signaling side (docs/specs/phase-b-contracts.md sections 3.1, 3.2, 6 B1): validation of the
 * `desk.consent.extension` decision against the org policy, and the `desk.consent_level` / `desk.consent_backstage`
 * changes during `active` (`consent.level_changed`, `consent.backstage_changed`, `consent.level_ok`, and
 * `consent.changed` to the Assist). The server cannot see the data channel, so it enforces the cap on what the Desk
 * grants and records every change; the extension refuses ops above the level.
 */
import { effectiveMaxLevel, isConsentLevel, levelAtLeast, type PackageTier, type SignalOf } from '@indiansassist/shared';
import { getSession, updateSession } from '@indiansassist/db';
import { deskActor, writeAudit } from '../lib/audit.js';
import type { Conn, Live, LiveConsent } from './conn.js';
import type { SignalHub } from './hub.js';
import { livePolicy, orgOf } from './messages.js';
import { authorizeSession } from './relay.js';
import { p3ConsentLevel } from './desk-p3.js';

type Grant = SignalOf<'desk.consent'>['extension'];

/** `desk.consent granted`: the consent triple to store (null for P1), or the `bad_payload` message. */
export async function checkGrant(
  hub: SignalHub,
  live: Live,
  tier: PackageTier,
  ext: Grant,
): Promise<{ ok: true; consent: LiveConsent | null } | { ok: false; message: string }> {
  if (tier !== 'p2_extension') {
    return ext === undefined ? { ok: true, consent: null } : { ok: false, message: 'extension consent is only valid in P2 sessions' };
  }
  if (!ext) return { ok: false, message: 'a P2 session needs extension: { level, scope, backstage }' };
  const policy = await livePolicy(hub, live);
  if (!levelAtLeast(effectiveMaxLevel(policy), ext.level)) return { ok: false, message: 'level exceeds the organisation maximum' };
  if (ext.scope === 'all_tabs' && !policy.allowAllTabs) return { ok: false, message: 'all_tabs is not allowed by the organisation' };
  if (ext.backstage && !policy.backstageAllowed) return { ok: false, message: 'background tabs are not allowed by the organisation' };
  return { ok: true, consent: { level: ext.level, scope: ext.scope, backstage: ext.backstage } };
}

/** The live P2 session in `active` this Desk socket is the participant of, else an error reply and null. */
async function activeP2(hub: SignalHub, conn: Conn, sessionId: string, t: string, reId: string | undefined) {
  const live = await authorizeSession(hub, conn, sessionId, t, reId);
  if (!live) return null;
  const s = await getSession(hub.ctx.db, sessionId);
  if (!s || s.state !== 'active') {
    conn.error('bad_state', `${t} needs an active session`, reId);
    return null;
  }
  if (s.tier !== 'p2_extension') {
    conn.error('bad_state', `${t} exists in P2 sessions only`, reId);
    return null;
  }
  const consent: LiveConsent = live.consent ?? {
    level: isConsentLevel(s.consentLevel) ? s.consentLevel : 'view',
    scope: s.consentScope ?? 'current_tab',
    backstage: s.consentBackstage === true,
  };
  return { live, s, consent };
}

function changed(hub: SignalHub, live: Live, sessionId: string, c: LiveConsent): void {
  hub.conn(live.assistConnId)?.send({ t: 'consent.changed', sessionId, state: 'granted', surface: 'browser', ...c });
}

const re = (id: string | undefined) => (id !== undefined ? { re: id } : {});

export async function handleDeskConsentLevel(hub: SignalHub, conn: Conn, msg: SignalOf<'desk.consent_level'>): Promise<void> {
  const { ctx } = hub;
  // Phase C section 3.4 family rule: a P3 session's levels are handled by desk-p3.ts.
  if (hub.live.get(msg.sessionId)?.tier === 'p3_portable') return p3ConsentLevel(hub, conn, msg);
  const a = await activeP2(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!a) return;
  const { live, s, consent } = a;
  const level = msg.level;
  if (!isConsentLevel(level)) return conn.error('bad_payload', 'not a P2 consent level', msg.id);
  if (!levelAtLeast(effectiveMaxLevel(await livePolicy(hub, live)), level))
    return conn.error('bad_payload', 'level exceeds the organisation maximum', msg.id);
  const requested = msg.requested === true;
  const from = consent.level;
  if (from !== level || requested) {
    const org = await orgOf(hub, s.orgId);
    await ctx.db.transaction(async (tx) => {
      await updateSession(tx, s.id, { consentLevel: level });
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor: deskActor(s.deskRef),
        action: 'consent.level_changed',
        data: { from, to: level, requestedBy: requested ? 'assist' : 'desk', ...(msg.opId ? { opId: msg.opId } : {}) },
      });
    });
  }
  live.consent = { ...consent, level };
  conn.send({ t: 'consent.level_ok', ...re(msg.id), sessionId: s.id, level, backstage: consent.backstage });
  changed(hub, live, s.id, live.consent);
}

export async function handleDeskConsentBackstage(
  hub: SignalHub,
  conn: Conn,
  msg: SignalOf<'desk.consent_backstage'>,
): Promise<void> {
  const { ctx } = hub;
  const a = await activeP2(hub, conn, msg.sessionId, msg.t, msg.id);
  if (!a) return;
  const { live, s, consent } = a;
  if (msg.backstage && !(await livePolicy(hub, live)).backstageAllowed)
    return conn.error('bad_payload', 'background tabs are not allowed by the organisation', msg.id);
  const from = consent.backstage;
  if (from !== msg.backstage) {
    const org = await orgOf(hub, s.orgId);
    await ctx.db.transaction(async (tx) => {
      await updateSession(tx, s.id, { consentBackstage: msg.backstage });
      await writeAudit(ctx, tx, org, {
        sessionId: s.id,
        actor: deskActor(s.deskRef),
        action: 'consent.backstage_changed',
        data: { from, to: msg.backstage },
      });
    });
  }
  const next: LiveConsent = { ...consent, backstage: msg.backstage };
  live.consent = next;
  conn.send({ t: 'consent.level_ok', ...re(msg.id), sessionId: s.id, level: consent.level, backstage: msg.backstage });
  changed(hub, live, s.id, next);
}
