/**
 * The console's notice for a `ctl.event capture` (docs/specs/phase-c-contracts.md section 4.1; Phase F section 9.3):
 * what the technician is told when the Desk's capture path changes. Pure, so the wording is tested on its own.
 *
 * Phase F section 9.3 (the Wayland portal build): `portal_closed` is the Desk user stopping the screen share from the
 * compositor (or the stream ending), `portal_denied` the user cancelling the compositor's source dialog. Both leave the
 * Desk without a screen for the rest of the session (re-asking is not automatic).
 */
export const PORTAL_CLOSED_NOTICE = 'The user stopped screen sharing.';
export const PORTAL_DENIED_NOTICE = 'The user did not allow screen sharing on the Desk.';
export const SECURE_DESKTOP_NOTICE = 'Waiting for the user to answer Windows.';
export const GDI_NOTICE = 'Compatibility capture (slower).';

/** The notice after `event`; `current` is the notice shown now (kept when the event says nothing new). */
export function captureNoticeFor(event: Record<string, unknown>, current: string | null): string | null {
  const { cause, path } = event;
  if (cause === 'portal_closed') return PORTAL_CLOSED_NOTICE;
  if (cause === 'portal_denied') return PORTAL_DENIED_NOTICE;
  if (cause === 'secure_desktop') return SECURE_DESKTOP_NOTICE;
  if (path === 'gdi') return GDI_NOTICE;
  if (cause === 'recovered') return null;
  // The portal stream starting clears a notice an earlier portal event left.
  if (path === 'portal' && cause === 'start') return null;
  return current;
}
