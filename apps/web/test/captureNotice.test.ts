/**
 * Phase F section 9.3: the console's words for the portal capture causes, and the earlier capture notices unchanged.
 */
import { CAPTURE_CAUSES } from '@indiansassist/shared';
import { describe, expect, it } from 'vitest';
import {
  captureNoticeFor,
  GDI_NOTICE,
  PORTAL_CLOSED_NOTICE,
  PORTAL_DENIED_NOTICE,
  SECURE_DESKTOP_NOTICE,
} from '../src/assist/console/agent/captureNotice';

describe('capture notices (Phase F section 9.3)', () => {
  it('says the user stopped screen sharing when the portal stream closes', () => {
    expect(PORTAL_CLOSED_NOTICE).toBe('The user stopped screen sharing.');
    expect(captureNoticeFor({ path: 'none', cause: 'portal_closed' }, null)).toBe(PORTAL_CLOSED_NOTICE);
  });

  it('says the user did not allow screen sharing when the source dialog is cancelled', () => {
    expect(captureNoticeFor({ path: 'none', cause: 'portal_denied' }, null)).toBe(PORTAL_DENIED_NOTICE);
  });

  it('clears a portal notice when the portal stream starts, and keeps the others as before', () => {
    expect(captureNoticeFor({ path: 'portal', cause: 'start' }, PORTAL_DENIED_NOTICE)).toBeNull();
    expect(captureNoticeFor({ path: 'dda', cause: 'secure_desktop' }, null)).toBe(SECURE_DESKTOP_NOTICE);
    expect(captureNoticeFor({ path: 'gdi', cause: 'dda_lost' }, null)).toBe(GDI_NOTICE);
    expect(captureNoticeFor({ path: 'dda', cause: 'recovered' }, GDI_NOTICE)).toBeNull();
    expect(captureNoticeFor({ path: 'xshm', cause: 'start' }, 'kept')).toBe('kept');
  });

  it('knows both portal causes by their shared names', () => {
    expect(CAPTURE_CAUSES).toContain('portal_closed');
    expect(CAPTURE_CAUSES).toContain('portal_denied');
  });
});
