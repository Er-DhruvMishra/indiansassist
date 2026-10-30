/**
 * `/signal` messages from the server to the Desk (Phase A section 7.3 plus Phase B sections 2.4, 3.1, 3.2, 3.5,
 * 4.6). Every frame was validated by the signal client; this maps each one onto the session machine.
 */
import { isConsentLevel, type ServerSignalMessage } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { REGION_ORIGINS } from '../shared/constants';
import { SESSION_KEYS, readSession, type PendingJoin } from '../shared/storage';
import { toRtcIceServers } from './ice';
import type { SessionMachine } from './session-machine';

const FATAL = new Set([
  'token_malformed',
  'token_bad_signature',
  'token_not_found',
  'token_gone',
  'region_mismatch',
  'token_busy',
  'join_unsupported',
  'not_authenticated',
  'forbidden',
]);

function mine(m: SessionMachine, sessionId: string | undefined): boolean {
  return !m.s?.sessionId || sessionId === undefined || sessionId === m.s.sessionId;
}

export async function openConsent(m: SessionMachine): Promise<void> {
  const s = m.s;
  if (!s?.sessionId || !m.eff) return;
  const pending = await readSession<PendingJoin>(SESSION_KEYS.pending);
  let candidate: number | null;
  try {
    const [active] = await ext().tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    const ours = (u?: string) => !!u && REGION_ORIGINS.some((o) => u.startsWith(`${o}/`));
    let pick = active;
    if (active && ours(active.url)) {
      const all = await ext().tabs.query({ windowType: 'normal' });
      pick = all.find((t) => t.windowId === active.windowId && !ours(t.url)) ?? all.find((t) => !ours(t.url)) ?? active;
    }
    candidate = pick?.id ?? null;
  } catch {
    candidate = null;
  }
  if (pending) await ext().storage.session.set({ [SESSION_KEYS.pending]: { ...pending, candidateTabId: candidate ?? undefined } });
  m.consentInfo = {
    sessionId: s.sessionId,
    technician: s.assist?.name ?? s.technician ?? 'Your technician',
    org: { displayName: s.org?.displayName ?? '', logoData: s.org?.logoData ?? null },
    maxLevel: m.eff.maxLevel,
    defaultLevel: m.eff.defaultLevel,
    allowAllTabs: m.eff.allowAllTabs,
    backstageAllowed: m.eff.backstageAllowed,
    managedLimited: m.eff.managedLimited,
    denyHosts: [...m.eff.denyList],
    candidateTabId: candidate,
  };
  m.persist();
  if (m.popupWindowId !== null) {
    await ext().windows.remove(m.popupWindowId).catch(() => undefined);
    m.popupWindowId = null;
  }
  m.consentWindowId = await m.openWindow(`consent.html?sessionId=${encodeURIComponent(s.sessionId)}`, 520, 820);
  m.persist();
}

export async function handleServerMessage(m: SessionMachine, msg: ServerSignalMessage): Promise<void> {
  const s = m.s;
  if (!s) return;
  switch (msg.t) {
    case 'desk.hello.ok': {
      s.tokenId = msg.tokenId;
      s.tier = msg.tier;
      s.technician = msg.technician?.name ?? s.technician;
      s.org = { displayName: msg.org.displayName, logoData: msg.org.logoData, accentColor: msg.org.accentColor };
      m.outbox.resend();
      if (s.endedLocally) {
        const pending = m.endPending;
        m.endPending = null;
        if (pending && msg.resume?.sessionId === s.sessionId) m.send(pending);
        else await m.finish(null);
        return;
      }
      if (msg.resume) {
        s.sessionId = msg.resume.sessionId;
        if (msg.resume.state === 'knocked') m.setPhase('knocked');
        m.persist();
        return;
      }
      s.resumeKey = null;
      m.setPhase('waiting');
      m.send({ t: 'desk.knock', ...(s.deskLabel ? { deskLabel: s.deskLabel } : {}) });
      return;
    }
    case 'knock.ok':
      s.resumeKey = msg.resumeKey;
      s.sessionId = msg.sessionId;
      m.setPhase('knocked');
      return;
    case 'knock.held':
      m.setPhase('held');
      return;
    case 'poll.status':
      if (msg.state === 'held' && m.phase === 'waiting') m.setPhase('held');
      else if (msg.state === 'waiting' && m.phase === 'held') m.setPhase('waiting');
      m.ui.set({ status: msg.technicianOnline ? null : 'Your technician is not online yet; the extension keeps trying.' });
      return;
    case 'session.created': {
      if (!mine(m, msg.sessionId) || s.endedLocally) return;
      s.sessionId = msg.sessionId;
      s.assist = { id: msg.assist.id, name: msg.assist.name };
      s.org = { displayName: msg.org.displayName, logoData: msg.org.logoData, accentColor: msg.org.accentColor };
      await m.setPolicy(msg.extension?.policy, null);
      if (msg.state === 'consent_pending' && s.phase !== 'consent_pending' && s.phase !== 'active') {
        m.setPhase('consent_pending');
        await openConsent(m);
      } else if (msg.state === 'active') {
        // Resume of an extension Desk keeps `active` (section 3.5); the next ice.refresh rebuilds the PC. When the
        // Desk was still consent_pending the consent.ok was lost: the session never started here, so the next
        // ice.refresh starts it (tabs classified, capture injected) instead of restoring an empty registry.
        const neverStarted = s.phase === 'consent_pending' && s.consent !== null && !m.live;
        if (neverStarted) {
          m.consentInfo = null;
          s.startedAt = m.now;
          m.pendingStart = true;
        } else m.expectRebuild = true;
        if (s.phase !== 'active') m.setPhase('active');
        if (!m.live && m.liveFactory) {
          m.live = m.liveFactory(m);
          if (!neverStarted) await m.live.restore();
        }
      }
      m.persist();
      return;
    }
    case 'consent.ok':
      if (msg.state !== 'active' || s.phase !== 'consent_pending' || !m.liveFactory) return;
      m.consentInfo = null;
      s.phase = 'active';
      s.startedAt = m.now;
      m.live = m.liveFactory(m);
      m.persist();
      await m.live.start(toRtcIceServers(msg.iceServers ?? []), false);
      return;
    case 'ice.refresh':
      if (!mine(m, msg.sessionId) || !m.live) return;
      if (m.pendingStart) {
        m.pendingStart = false;
        m.expectRebuild = false;
        await m.live.start(toRtcIceServers(msg.iceServers), true);
      } else if (m.expectRebuild) {
        m.expectRebuild = false;
        await m.live.rebuild(toRtcIceServers(msg.iceServers));
      } else {
        m.live.iceServers = toRtcIceServers(msg.iceServers);
        await m.offscreen.send({ t: 'pc.ice', iceServers: m.live.iceServers });
      }
      return;
    case 'webrtc.offer':
    case 'webrtc.answer':
    case 'webrtc.ice':
      if (mine(m, msg.sessionId)) await m.offscreen.send({ t: 'pc.signal', msg: msg as unknown as Record<string, unknown> });
      return;
    case 'consent.level_ok':
      // Phase C widened `consent.level_ok.level` to both families; a P2 Desk only ever receives a P2 level.
      if (!mine(m, msg.sessionId) || !isConsentLevel(msg.level)) return;
      m.live?.levelConfirmed(msg.level, msg.backstage);
      m.resolveLevel(msg.re, true);
      return;
    case 'session.recording':
      if (mine(m, msg.sessionId)) m.live?.setRecording(msg.recording);
      return;
    case 'chat.message':
      if (mine(m, msg.sessionId) && msg.from === 'assist') m.live?.receiveChat({ msgId: msg.msgId, from: 'assist', text: msg.text, ts: msg.ts ?? Date.now() });
      return;
    case 'mirror.relay':
      if (mine(m, msg.sessionId)) await m.offscreen.send({ t: 'relay.inbound', msg: msg as unknown as Record<string, unknown> });
      return;
    case 'control.relay':
      if (mine(m, msg.sessionId)) await m.live?.control.handle(msg.msg);
      return;
    case 'event.ok':
      m.outbox.ack(msg.re);
      return;
    case 'session.ended':
      if (mine(m, msg.sessionId)) await m.finish(msg, msg.endReason);
      return;
    case 'error':
      if (msg.code === 'rate_limited' && msg.re?.startsWith('e')) return m.outbox.rateLimited(msg.re);
      if (msg.re?.startsWith('e')) return m.outbox.refused(msg.re);
      m.resolveLevel(msg.re, false); // only the desk.consent_level frame this error answers
      if (FATAL.has(msg.code)) {
        if (s.endedLocally) return m.finish(null);
        return m.fail({ code: msg.code, message: msg.message || 'The session could not continue.' });
      }
      m.ui.set({ lastError: { code: msg.code, message: msg.message } });
      return;
    default:
      return;
  }
}
