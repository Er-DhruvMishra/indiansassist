/**
 * Phase F section 7.4: which layout a viewport gets, and the phone layout's tab bar (every section stays mounted,
 * only the chosen one is shown; End is always in the one-line header).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MobileConsoleLayout, type ConsoleSection, type ConsoleTab } from '../src/assist/touch/MobileConsoleLayout';
import { layoutFor } from '../src/assist/touch/useViewport';
import { defaultTrackpad } from '../src/assist/touch/TouchControls';
import { useState } from 'react';

describe('layoutFor (section 7.4)', () => {
  it('maps the widths of the table', () => {
    expect(layoutFor(393, 852, false)).toBe('phone'); // iPhone 15 portrait
    expect(layoutFor(412, 915, false)).toBe('phone'); // Pixel 7 portrait
    expect(layoutFor(915, 412, false)).toBe('phone_landscape'); // Pixel 7 landscape
    expect(layoutFor(834, 1194, false)).toBe('tablet'); // iPad Pro 11 portrait
    expect(layoutFor(1194, 834, false)).toBe('desktop'); // iPad Pro 11 landscape: today's layout
    expect(layoutFor(1440, 1000, false)).toBe('desktop');
    expect(layoutFor(900, 700, true)).toBe('phone_landscape'); // installed app in landscape
    expect(layoutFor(900, 700, false)).toBe('tablet');
  });

  it('Trackpad defaults on below 600 px only', () => {
    expect(defaultTrackpad(412)).toBe(true);
    expect(defaultTrackpad(834)).toBe(false);
  });
});

function Phone({ onEnd }: { onEnd: () => void }) {
  const [tab, setTab] = useState<ConsoleTab>('view');
  const sections: ConsoleSection[] = [
    { id: 'view', label: 'View', content: <p>view tools</p> },
    { id: 'chat', label: 'Chat', content: <input aria-label="Message" defaultValue="" /> },
    { id: 'files', label: 'Files', content: <p>files panel</p> },
    { id: 'keys', label: 'Keys', content: <p>keys panel</p> },
    { id: 'more', label: 'More', content: <p>more panel</p> },
  ];
  return (
    <MobileConsoleLayout layout="phone" title="Session with Desk" badges={<span>123 456</span>} onEnd={onEnd} status={<p>Live</p>} view={<div>remote view</div>} sections={sections} active={tab} onActive={setTab} />
  );
}

describe('the phone layout', () => {
  it('has the bottom tab bar, shows one sheet at a time and keeps the others mounted', () => {
    const onEnd = vi.fn();
    render(<Phone onEnd={onEnd} />);
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['View', 'Chat', 'Files', 'Keys', 'More']);
    expect(screen.getByText('view tools')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'View' }).getAttribute('aria-selected')).toBe('true');
    const message = screen.getByLabelText('Message', { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(message, { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByText('view tools').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(true);
    expect((screen.getByText('files panel').closest('[role="tabpanel"]') as HTMLElement).hidden).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    // The chat draft survived the switch (sections stay mounted).
    expect((screen.getByLabelText('Message', { selector: 'input' }) as HTMLInputElement).value).toBe('draft');
    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByText('remote view')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Session with Desk' })).toBeTruthy();
  });
});
