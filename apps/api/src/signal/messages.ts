/** Builders for server -> client signaling messages (contracts section 7.3) and session timers. */
import { iceRefreshDelayMs, isNativeTier, mergePolicy, sanitiseText, SANITISE_LIMITS, type ExtensionPolicy } from '@indiansassist/shared';
import { getOrg, getSession, type OrgRow, type SessionRow, type TokenRow } from '@indiansassist/db';
import { buildIceServers } from '../lib/ice.js';
import { brandingPublic, type UserRef } from '../lib/mappers.js';
import { endSessionQuietly } from '../services/session-end.js';
import { systemActor } from '../lib/audit.js';
import { iso } from '../lib/time.js';
import { agentOfRow, clearTimer, consentOfRow, deskAnswersRecorder, newLive, setTimer, type Live } from './conn.js';
import type { SignalHub } from './hub.js';

export function ensureLive(hub: SignalHub, s: SessionRow): Live {
  let live = hub.live.get(s.id);
  if (!live) {
    live = newLive(s);
    hub.live.set(s.id, live);
  }
  live.state = s.state;
  live.path = s.path;
  live.tier = s.tier;
  live.consent = consentOfRow(s);
  live.agent = agentOfRow(s);
  live.recordingMode = s.recordingMode ?? null;
  live.deskRecorder = deskAnswersRecorder(s.deskClient);
  return live;
}

/** The org extension policy merged over the defaults (Phase B 11.1). */
export function policyOf(org: Pick<OrgRow, 'extensionPolicy'>): ExtensionPolicy {
  return mergePolicy(org.extensionPolicy);
}

/** The policy of a live P2 session, loaded once (live sessions are not re-policed, Phase B 11.3). */
export async function livePolicy(hub: SignalHub, live: Live): Promise<ExtensionPolicy> {
  if (!live.policy) live.policy = policyOf(await orgOf(hub, live.orgId));
  return live.policy;
}

export function assistKnockMsg(
  s: SessionRow,
  tok: TokenRow,
  creator: UserRef,
  canAct: boolean,
): Record<string, unknown> {
  const knockedAt = s.knockedAt.getTime();
  return {
    t: 'assist.knock',
    sessionId: s.id,
    tokenId: tok.id,
    tokenLabel: tok.label ?? null,
    tokenCreatedBy: creator,
    deskLabel: s.deskLabel ?? null,
    userAgent: s.deskUserAgent ?? null,
    knockedAt: iso(s.knockedAt),
    expiresAt: iso(s.knockExpiresAt ?? new Date(knockedAt + 120_000)),
    canAct,
  };
}

/** `session.created`; ICE fields only on the Assist copy (section 6.11). */
export function sessionCreatedMsg(
  hub: SignalHub,
  s: SessionRow,
  org: OrgRow,
  assist: UserRef,
  side: 'assist' | 'desk',
): Record<string, unknown> {
  const base = {
    t: 'session.created',
    sessionId: s.id,
    tokenId: s.tokenId,
    tier: s.tier,
    state: s.state,
    consentState: s.consentState,
    assist,
    desk: { label: s.deskLabel ?? 'Desk' },
    org: brandingPublic(org),
    polite: side === 'assist',
    recordingMode: s.recordingMode ?? 'assist_only',
    ...(s.tier === 'p2_extension' ? { extension: { policy: hub.live.get(s.id)?.policy ?? policyOf(org) } } : {}),
    // Phase C section 8.3: both copies of a native session carry the pinned manifest (loaded by ensureAgentManifest).
    ...(isNativeTier(s.tier) ? { agent: hub.live.get(s.id)?.manifest?.msg ?? { playbooks: [] } } : {}),
    // Phase D section 3.5 step 4: a P4 session carries the device (identity key for rule 3.5b) and `unattended`.
    ...(s.deviceId ? p4CreatedFields(hub, s) : {}),
  };
  if (side === 'desk') return base;
  return { ...base, ...buildIceServers(hub.ctx.config, `user:${assist.id}`) };
}

function p4CreatedFields(hub: SignalHub, s: SessionRow): Record<string, unknown> {
  const d = hub.live.get(s.id)?.p4?.device ?? null;
  return { ...(d ? { device: d } : {}), unattended: s.unattended === true };
}

export function deskIce(hub: SignalHub, sessionId: string): Record<string, unknown> {
  return { ...buildIceServers(hub.ctx.config, `desk:${sessionId}`) };
}

export function deskLabelOf(raw: string | null | undefined): string {
  const s = sanitiseText(raw ?? '', SANITISE_LIMITS.deskLabel).trim();
  return s === '' ? 'Desk' : s;
}

// ---------- timers (in-memory optimisation; the sweeper backs them up from the row deadlines, N5) ----------

export function startKnockTimer(hub: SignalHub, live: Live): void {
  setTimer(live, 'knock', hub.ctx.timing.knockTimeoutMs, () => {
    void endSessionQuietly(hub.ctx, live.id, { reason: 'timeout', actor: systemActor, from: ['knocked'] }).catch(
      (err: unknown) => hub.ctx.log.error({ err, sessionId: live.id }, 'knock timeout failed'),
    );
  });
}

export function startConsentTimer(hub: SignalHub, live: Live): void {
  setTimer(live, 'consent', hub.ctx.timing.consentTimeoutMs, () => {
    void endSessionQuietly(hub.ctx, live.id, {
      reason: 'timeout',
      actor: systemActor,
      from: ['accepted', 'consent_pending'],
    }).catch((err: unknown) => hub.ctx.log.error({ err, sessionId: live.id }, 'consent timeout failed'));
  });
}

export function stopConsentTimer(live: Live): void {
  clearTimer(live, 'consent');
}

/** `ice.refresh` at 80 % of iceTtl after the last credential issued to a side (section 6.11). */
export function scheduleIceRefresh(hub: SignalHub, live: Live, side: 'assist' | 'desk'): void {
  const name = `ice-${side}`;
  setTimer(live, name, iceRefreshDelayMs(hub.ctx.config.turnTtlSeconds), () => {
    void (async () => {
      if (live.state === 'ended') return;
      const s = await getSession(hub.ctx.db, live.id);
      if (!s || s.state === 'ended') return;
      if (s.state === 'active') {
        const connId = side === 'assist' ? live.assistConnId : live.deskConnId;
        const conn = hub.conn(connId);
        const ice =
          side === 'assist' ? buildIceServers(hub.ctx.config, `user:${s.assistUserId}`) : deskIce(hub, s.id);
        conn?.send({ t: 'ice.refresh', sessionId: s.id, ...ice });
      }
      scheduleIceRefresh(hub, live, side);
    })().catch((err: unknown) => hub.ctx.log.error({ err, sessionId: live.id }, 'ice refresh failed'));
  });
}

export async function orgOf(hub: SignalHub, orgId: string): Promise<OrgRow> {
  const org = await getOrg(hub.ctx.db, orgId);
  if (!org) throw new Error(`org ${orgId} not found`);
  return org;
}
