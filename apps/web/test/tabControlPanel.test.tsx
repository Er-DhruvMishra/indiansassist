/**
 * Tab control panel (Phase B 5.3, 10.1, PRD 3 P2 "rearrange tab groups, move tabs"; prd-F10): the Move row lists
 * the Desk's windows (`windows.list`) and sends `tabs.move` with the chosen `windowId`; each listed group has
 * **Move group** (`tabGroups.move`); both are disabled below `tab_control`.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TabInfo } from '@indiansassist/shared';
import { TabControlPanel, parseMoveIndex, windowLabel } from '../src/assist/console/mirror/TabControlPanel';
import type { ControlResult } from '../src/assist/console/mirror/controlClient';

const tab: TabInfo = { tabId: 7, windowId: 1, index: 0, title: 'Form', url: 'https://a.example/', favicon: null, active: true, pinned: false, muted: false, audible: false, groupId: -1, status: 'complete', mirrored: 'yes', backstage: false, createdByAssist: false, revealed: 'none', discarded: false };
const windows = [
  { windowId: 1, focused: true, state: 'normal', type: 'normal', tabCount: 3, incognito: false },
  { windowId: 2, focused: false, state: 'minimized', type: 'normal', tabCount: 1, incognito: false },
];
const groups = [{ groupId: 11, windowId: 1, title: 'Work', color: 'blue', collapsed: false, tabIds: [7] }];

function setup(canTab = true) {
  const onOp = vi.fn(async (op: string): Promise<ControlResult> => {
    if (op === 'windows.list') return { ok: true, result: { windows } };
    if (op === 'tabGroups.list') return { ok: true, result: { groups } };
    return { ok: true, result: {} };
  });
  render(<TabControlPanel tab={tab} canTab={canTab} onOp={onOp as never} />);
  return onOp;
}

describe('TabControlPanel move controls', () => {
  it('moves the tab to a position in another window chosen from windows.list', async () => {
    const onOp = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'List windows' }));
    expect(onOp).toHaveBeenCalledWith('windows.list', {}, 'Windows loaded.');
    const select = screen.getByLabelText('Window');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Same window', 'Window 1 (3 tabs, in front)', 'Window 2 (1 tab, minimised)']);
    await user.selectOptions(select, '2');
    const index = screen.getByLabelText('Move to position');
    await user.clear(index);
    await user.type(index, '-1');
    await user.click(screen.getByRole('button', { name: 'Move tab' }));
    expect(onOp).toHaveBeenLastCalledWith('tabs.move', { tabIds: [7], index: -1, windowId: 2 }, 'Moved.');
    await user.selectOptions(select, '');
    await user.click(screen.getByRole('button', { name: 'Move tab' }));
    expect(onOp).toHaveBeenLastCalledWith('tabs.move', { tabIds: [7], index: -1 }, 'Moved.');
  });

  it('moves a listed tab group with tabGroups.move', async () => {
    const onOp = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'List windows' }));
    await user.selectOptions(screen.getByLabelText('Window'), '2');
    await user.click(screen.getByRole('button', { name: 'List groups' }));
    await user.click(await screen.findByRole('button', { name: 'Move group Work' }));
    expect(onOp).toHaveBeenCalledWith('tabGroups.move', { groupId: 11, index: 0, windowId: 2 }, 'Group moved.');
  });

  it('disables the move controls below tab_control', async () => {
    setup(false);
    for (const name of ['Move tab', 'List windows']) {
      const b = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toMatch(/Switch and open tabs/);
    }
    expect((screen.getByLabelText('Window') as HTMLSelectElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'List groups' }));
    expect((screen.getByRole('button', { name: 'Move group Work' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('clamps the position to the op catalogue range and labels windows', () => {
    expect(parseMoveIndex('20000')).toBe(10_000);
    expect(parseMoveIndex('-5')).toBe(-1);
    expect(parseMoveIndex('abc')).toBe(0);
    expect(windowLabel({ windowId: 3, focused: false, state: 'normal', type: 'popup', tabCount: 2, incognito: false })).toBe('Popup window 3 (2 tabs)');
  });
});
