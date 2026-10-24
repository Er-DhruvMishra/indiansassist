/**
 * The consent window across a service-worker restart (section 3.1, correctness-F10). `consentInfo` and
 * `consentWindowId` live in `ia.session`, so the restarted worker still treats the window closing unanswered as a
 * Decline. Called once after `SessionMachine.restore()`: a window that is already gone while no answer was recorded
 * was closed unanswered (Decline); a prompt the old worker never opened (it died first) is opened now.
 */
import { ext } from '../shared/api';
import { openConsent } from './server-messages';
import { decline } from './session-end';
import type { SessionMachine } from './session-machine';

export async function restoreConsentWindow(m: SessionMachine): Promise<void> {
  const s = m.s;
  if (!s || s.phase !== 'consent_pending' || s.consent || !s.sessionId) return;
  const id = m.consentWindowId;
  if (id === null) return openConsent(m);
  const alive = await ext()
    .windows.get(id)
    .then(() => true)
    .catch(() => false);
  if (!alive) {
    m.consentWindowId = null;
    decline(m);
  }
}
