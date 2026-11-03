/**
 * Phase F section 3.4b (stream fixes): the console shows the Desk user's Keep choice read-only. The agent's
 * `ctl.event keep { kept }` frame (the shape `ia-agent` sends, `serve/selfdel.rs` `keep_event`) is a valid control
 * event; `<DeskKeepSlot>` renders the words only when kept, offers no control that could set it, and announces a
 * change politely.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { agentControlEventSchema } from '@indiansassist/shared';
import { DeskKeepSlot } from '../src/assist/console/PhaseFSlots';
import { KEEP_STATE_TEXT } from '../src/assist/console/agent/KeepState';

describe('KeepState (section 3.4b)', () => {
  it('accepts the agent frame and nothing beyond it', () => {
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'keep', kept: true, ts: 42 }).success).toBe(true);
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'keep', kept: false, ts: 42 }).success).toBe(true);
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'keep', kept: 'yes', ts: 42 }).success).toBe(false);
    expect(agentControlEventSchema.safeParse({ t: 'ctl.event', kind: 'keep', kept: true, ts: 42, by: 'assist' }).success).toBe(false);
  });

  it('shows the choice in words only when kept, read-only', () => {
    const { rerender } = render(<DeskKeepSlot kept={null} />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    rerender(<DeskKeepSlot kept={false} />);
    expect(screen.getByRole('status').textContent).toBe('');
    rerender(<DeskKeepSlot kept={true} />);
    expect(screen.getByRole('status').textContent).toBe(KEEP_STATE_TEXT);
    expect(KEEP_STATE_TEXT).toBe('The user chose to keep IndiansAssist on this computer.');
    // The console cannot set Keep: no button, checkbox, switch or link of any kind.
    for (const role of ['button', 'checkbox', 'switch', 'link', 'menuitem'] as const) expect(screen.queryByRole(role)).toBeNull();
    // Unticked again on the Desk: the words go.
    rerender(<DeskKeepSlot kept={false} />);
    expect(screen.getByRole('status').textContent).toBe('');
  });
});
