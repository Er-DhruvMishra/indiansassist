/**
 * Desk-initiated ends (section 3.4, Phase A D4 / D5 / prd-F1): Stop sharing, Revoke consent, Decline and Cancel.
 * The local end is immediate and final: `endedLocally` is persisted so neither a resume nor a re-sent
 * `session.created` brings the session back; the end frame is sent now or after the next `desk.hello.ok`; the
 * receipt follows `session.ended` or, at the latest, the 5 s local fallback.
 */
import type { ClientSignalMessage } from '@indiansassist/shared';
import { teardownLive } from './live-teardown';
import { LOCAL_END_FALLBACK_MS, type SessionMachine } from './session-machine';

function endLocally(m: SessionMachine, msg: ClientSignalMessage, reason: string): void {
  const s = m.s;
  if (!s) return;
  s.endedLocally = true;
  m.persist();
  if (m.send(msg)) m.endPending = null;
  else m.endPending = msg;
  if (m.endFallback) clearTimeout(m.endFallback);
  m.endFallback = setTimeout(() => void m.finish(null, reason), LOCAL_END_FALLBACK_MS);
}

/** Stop sharing (bar or side panel), D4 order: ctrl message and teardown first, then WS `session.end`. */
export async function stopSharing(m: SessionMachine, closeBackstage: boolean): Promise<void> {
  const live = m.live;
  const sessionId = m.s?.sessionId;
  if (!live || !sessionId || m.phase !== 'active') return cancel(m);
  if (live.finishing) return;
  live.finishing = true;
  m.refreshUi();
  await teardownLive(live, 'ended', closeBackstage, 'stop.sharing', true);
  m.live = null;
  endLocally(m, { t: 'session.end', sessionId }, 'desk_stopped');
}

/** Revoke consent (side panel menu), D5 order: the ctrl message leaves before the channels close. */
export async function revokeConsent(m: SessionMachine): Promise<void> {
  const live = m.live;
  if (!live || m.phase !== 'active') return;
  if (live.finishing) return;
  live.finishing = true;
  m.refreshUi();
  await teardownLive(live, 'revoked', true, 'consent.revoked', true);
  m.live = null;
  endLocally(m, { t: 'desk.consent', state: 'revoked' }, 'consent_revoked');
}

/** Decline in the consent window (or the window closed): nothing was ever shared. */
export function decline(m: SessionMachine): void {
  if (m.phase !== 'consent_pending') return;
  m.consentInfo = null;
  endLocally(m, { t: 'desk.consent', state: 'revoked' }, 'consent_revoked');
}

/** Cancel (popup Cancel, side panel Cancel, options Reset): before consent ends the session, after it stops sharing. */
export async function cancel(m: SessionMachine): Promise<void> {
  const s = m.s;
  if (!s) return;
  if (s.phase === 'consent_pending') return decline(m);
  if (s.phase === 'active' && m.live && s.sessionId) return stopSharing(m, true);
  if (s.sessionId) return endLocally(m, { t: 'session.end', sessionId: s.sessionId }, 'desk_left');
  await m.fail({ code: 'cancelled', message: 'Cancelled.' });
  m.ui.set({ lastError: null });
}
