import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DENY_LIST } from '@indiansassist/shared';
import { ControlError } from '../src/background/gate';
import { assertNavigableUrl, openBackstageTab, runTabOp, type TabsDeps } from '../src/background/tabs-control';
import { toTabInfo } from '../src/background/tab-registry';
import { installChromeMock, makeTab, type ChromeMock } from './chrome-mock';

const DENY = [...BUILTIN_DENY_LIST, '127.0.0.1'];
let chrome: ChromeMock;
let deps: TabsDeps;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ControlError ? e.code : 'other';
  }
}

beforeEach(() => {
  chrome = installChromeMock({ tabs: [makeTab(1, 'https://example.com/', { active: true }), makeTab(2, 'https://example.org/'), makeTab(3, 'http://127.0.0.1:4175/')] });
  deps = {
    denyList: () => DENY,
    info: (t) => toTabInfo(t, { mirrored: 'yes', paused: false, inScope: true, backstage: false, createdByAssist: false, enteredAt: 0, injected: true, host: null }, null),
    onCreated: vi.fn(),
  };
});

describe('assertNavigableUrl (section 5.2)', () => {
  it('normalises http(s) URLs and refuses other schemes (bad_args) and denied hosts (denied_url)', async () => {
    expect(assertNavigableUrl('HTTPS://Example.COM/a b', DENY)).toBe('https://example.com/a%20b');
    for (const u of ['chrome://settings', 'file:///C:/x', 'javascript:alert(1)', 'view-source:https://x.com', 'about:blank', 'chrome-extension://abc/x', 'not a url'])
      expect(await code(Promise.resolve().then(() => assertNavigableUrl(u, DENY)))).toBe('bad_args');
    expect(await code(Promise.resolve().then(() => assertNavigableUrl('https://accounts.google.com/', DENY)))).toBe('denied_url');
    expect(await code(Promise.resolve().then(() => assertNavigableUrl('http://127.0.0.1:4175/', DENY)))).toBe('denied_url');
  });
});

describe('tab op mapping (section 5.3)', () => {
  it('tabs.create opens an active tab through assertNavigableUrl and registers it as Assist-created', async () => {
    const r = await runTabOp('tabs.create', { url: 'https://example.net/x', pinned: true }, deps);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ active: true, url: 'https://example.net/x', pinned: true });
    expect(deps.onCreated).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.net/x' }), false);
    expect((r.tab as { url: string }).url).toBe('https://example.net/x');
    expect(await code(runTabOp('tabs.create', { url: 'https://accounts.google.com/' }, deps))).toBe('denied_url');
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('tabs.navigate, tabs.reload, activate, pin, mute map onto chrome.tabs / chrome.windows', async () => {
    await runTabOp('tabs.navigate', { tabId: 2, url: 'https://example.org/next' }, deps);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { url: 'https://example.org/next' });
    expect(await code(runTabOp('tabs.navigate', { tabId: 2, url: 'http://127.0.0.1:4175/' }, deps))).toBe('denied_url');
    expect(await code(runTabOp('tabs.reload', { tabId: 3 }, deps))).toBe('denied_url');
    await runTabOp('tabs.reload', { tabId: 1, bypassCache: true }, deps);
    expect(chrome.tabs.reload).toHaveBeenCalledWith(1, { bypassCache: true });
    await runTabOp('tabs.activate', { tabId: 2 }, deps);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    await runTabOp('tabs.pin', { tabId: 2, pinned: true }, deps);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { pinned: true });
    await runTabOp('tabs.mute', { tabId: 2, muted: true }, deps);
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, { muted: true });
  });

  it('tabs.close reports the tabs actually closed; tabs.move moves them', async () => {
    expect(await runTabOp('tabs.close', { tabIds: [2, 99] }, deps)).toEqual({ closed: [2] });
    const moved = await runTabOp('tabs.move', { tabIds: [1], index: 0 }, deps);
    expect(chrome.tabs.move).toHaveBeenCalledWith([1], { index: 0 });
    expect((moved.tabs as unknown[]).length).toBe(1);
  });

  it('tab group ops map onto chrome.tabs.group / ungroup and chrome.tabGroups', async () => {
    const created = await runTabOp('tabGroups.create', { tabIds: [1, 2], title: 'Work', color: 'blue' }, deps);
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [1, 2] });
    const gid = (created.group as { groupId: number }).groupId;
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(gid, { title: 'Work', color: 'blue' });
    expect(created.group).toMatchObject({ title: 'Work', color: 'blue', tabIds: [1, 2] });
    await runTabOp('tabGroups.collapse', { groupId: gid, collapsed: true }, deps);
    expect(chrome.tabGroups.update).toHaveBeenLastCalledWith(gid, { collapsed: true });
    await runTabOp('tabGroups.move', { groupId: gid, index: 0 }, deps);
    expect(chrome.tabGroups.move).toHaveBeenCalledWith(gid, { index: 0 });
    const listed = await runTabOp('tabGroups.list', {}, deps);
    expect((listed.groups as unknown[]).length).toBe(1);
    await runTabOp('tabGroups.ungroup', { tabIds: [1] }, deps);
    expect(chrome.tabs.ungroup).toHaveBeenCalledWith([1]);
  });

  it('tabs.reload of a chrome:// or file: tab answers bad_args (prd-F7)', async () => {
    chrome.tabsStore.set(7, makeTab(7, 'chrome://settings/'));
    chrome.tabsStore.set(8, makeTab(8, 'file:///C:/Users/x/salary.pdf'));
    expect(await code(runTabOp('tabs.reload', { tabId: 7 }, deps))).toBe('bad_args');
    expect(await code(runTabOp('tabs.reload', { tabId: 8 }, deps))).toBe('bad_args');
    expect(chrome.tabs.reload).not.toHaveBeenCalled();
  });

  it('under current_tab tab groups never disclose unshared tabs or their group titles (SEC-P2-03)', async () => {
    const created = await runTabOp('tabGroups.create', { tabIds: [1, 2], title: 'Work' }, deps);
    const shared = (created.group as { groupId: number }).groupId;
    const hidden = await chrome.tabs.group({ tabIds: [3] });
    await chrome.tabGroups.update(hidden, { title: 'Bank stuff' });
    const scoped: TabsDeps = { ...deps, listed: (id) => id === 1 };
    const listed = (await runTabOp('tabGroups.list', {}, scoped)).groups as { groupId: number; title: string; tabIds: number[] }[];
    expect(listed).toEqual([expect.objectContaining({ groupId: shared, tabIds: [1] })]);
    expect(JSON.stringify(listed)).not.toContain('Bank stuff');
    chrome.tabGroups.update.mockClear();
    expect(await code(runTabOp('tabGroups.update', { groupId: hidden, title: 'x' }, scoped))).toBe('not_in_scope');
    expect(await code(runTabOp('tabGroups.move', { groupId: hidden, index: 0 }, scoped))).toBe('not_in_scope');
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
    expect(chrome.tabGroups.move).not.toHaveBeenCalled();
  });

  it('windows.list never lists incognito windows; unknown ops answer not_supported', async () => {
    const r = await runTabOp('windows.list', {}, deps);
    expect(r.windows).toEqual([{ windowId: 1, focused: true, state: 'normal', type: 'normal', tabCount: 3, incognito: false }]);
    expect(await code(runTabOp('tabs.discard', {}, deps))).toBe('not_supported');
  });

  it('backstage.enter opens a background tab (never active, never a window focus)', async () => {
    const tab = await openBackstageTab('https://example.net/', undefined, deps);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.net/', active: false });
    expect(chrome.windows.update).not.toHaveBeenCalled();
    expect(deps.onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id }), true);
    expect(await code(openBackstageTab('chrome://settings', undefined, deps))).toBe('bad_args');
  });
});
