/**
 * Tab, tab group and window ops of the control protocol (section 5.3), mapped onto `chrome.tabs`,
 * `chrome.tabGroups` and `chrome.windows`, and `assertNavigableUrl` (section 5.2), the one URL check used by
 * `tabs.create`, `tabs.navigate`, `tabs.reload` and `backstage.enter`.
 */
import { isMirrorableUrl, matchesDenyList, type GroupInfo, type TabInfo, type WindowInfo } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { ControlError } from './gate';

/** `new URL` normalisation (`bad_args`), http(s) only (`bad_args`), then the deny list on the final host (`denied_url`). */
export function assertNavigableUrl(url: string, denyList: readonly string[]): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ControlError('bad_args', 'not a URL');
  }
  const href = u.href;
  if (!isMirrorableUrl(href)) throw new ControlError('bad_args', 'only http and https pages can be opened');
  if (matchesDenyList(href, denyList)) throw new ControlError('denied_url', 'this site is protected');
  return href;
}

export type TabsDeps = {
  denyList: () => readonly string[];
  info: (tab: chrome.tabs.Tab) => TabInfo | null;
  /** The Assist created a tab (`tabs.create`, `backstage.enter`): registry entry and capture injection. */
  onCreated: (tab: chrome.tabs.Tab, backstage: boolean) => Promise<void> | void;
  /** Whether the Assist sees this tab (scope `current_tab` hides unshared tabs); absent = every tab. */
  listed?: (tabId: number) => boolean;
};

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await ext().tabs.get(tabId);
  } catch {
    throw new ControlError('no_such_tab', 'no such tab');
  }
}

function tabResult(deps: TabsDeps, tab: chrome.tabs.Tab | undefined): { tab: TabInfo } {
  const info = tab ? deps.info(tab) : null;
  if (!info) throw new ControlError('internal', 'tab unavailable');
  return { tab: info };
}

function groupInfo(g: chrome.tabGroups.TabGroup, tabIds: number[]): GroupInfo {
  return {
    groupId: g.id,
    windowId: g.windowId,
    title: (g.title ?? '').slice(0, 200),
    color: g.color as GroupInfo['color'],
    collapsed: g.collapsed,
    tabIds,
  };
}

/**
 * A group with only the tabs the Assist sees (SEC-P2-03). A group made only of unshared tabs is `not_in_scope`
 * (`null` when `allowHidden`, used by `tabGroups.list` to skip it), so its title never reaches the Assist.
 */
async function groupWithTabs(groupId: number, deps: TabsDeps, allowHidden = false): Promise<GroupInfo | null> {
  let g: chrome.tabGroups.TabGroup;
  try {
    g = await ext().tabGroups.get(groupId);
  } catch {
    throw new ControlError('bad_args', 'no such group');
  }
  const tabs = await ext().tabs.query({ groupId });
  const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined && (deps.listed?.(id) ?? true));
  if (ids.length === 0 && tabs.length > 0) {
    if (allowHidden) return null;
    throw new ControlError('not_in_scope', 'this group is not shared');
  }
  return groupInfo(g, ids);
}

async function visibleGroup(groupId: number, deps: TabsDeps): Promise<GroupInfo> {
  return (await groupWithTabs(groupId, deps))!;
}

type Args = Record<string, unknown> & { tabId?: number; tabIds?: number[]; groupId?: number };

/** Executes one tab / group / window op whose request already passed the schema and the gate. */
export async function runTabOp(op: string, a: Args, deps: TabsDeps): Promise<Record<string, unknown>> {
  const t = ext().tabs;
  switch (op) {
    case 'tabs.activate': {
      const tab = await t.update(a.tabId!, { active: true });
      if (tab?.windowId !== undefined) await ext().windows.update(tab.windowId, { focused: true });
      return tabResult(deps, tab);
    }
    case 'tabs.create': {
      const url = typeof a.url === 'string' ? assertNavigableUrl(a.url, deps.denyList()) : undefined;
      const props: chrome.tabs.CreateProperties = { active: true };
      if (url) props.url = url;
      if (typeof a.windowId === 'number') props.windowId = a.windowId;
      if (typeof a.index === 'number' && a.index >= 0) props.index = a.index;
      if (typeof a.pinned === 'boolean') props.pinned = a.pinned;
      const tab = await t.create(props);
      await deps.onCreated(tab, false);
      return tabResult(deps, tab);
    }
    case 'tabs.close': {
      const closed: number[] = [];
      for (const id of a.tabIds!) {
        try {
          await t.remove(id);
          closed.push(id);
        } catch {
          /* already gone */
        }
      }
      return { closed };
    }
    case 'tabs.reload': {
      const cur = await getTab(a.tabId!);
      // Always checked (prd-F7): a chrome:// / file: page answers bad_args, a denied page denied_url.
      assertNavigableUrl(cur.url ?? cur.pendingUrl ?? '', deps.denyList());
      await t.reload(a.tabId!, { bypassCache: a.bypassCache === true });
      return {};
    }
    case 'tabs.navigate': {
      const url = assertNavigableUrl(String(a.url), deps.denyList());
      return tabResult(deps, await t.update(a.tabId!, { url }));
    }
    case 'tabs.pin':
      return tabResult(deps, await t.update(a.tabId!, { pinned: a.pinned === true }));
    case 'tabs.mute':
      return tabResult(deps, await t.update(a.tabId!, { muted: a.muted === true }));
    case 'tabs.move': {
      const props: chrome.tabs.MoveProperties = { index: Number(a.index) };
      if (typeof a.windowId === 'number') props.windowId = a.windowId;
      const moved = await t.move(a.tabIds!, props);
      const list = (Array.isArray(moved) ? moved : [moved]).map((x) => deps.info(x)).filter((x): x is TabInfo => x !== null);
      return { tabs: list };
    }
    case 'tabGroups.list': {
      const groups = await ext().tabGroups.query(typeof a.windowId === 'number' ? { windowId: a.windowId } : {});
      const out: GroupInfo[] = [];
      for (const g of groups) {
        const info = await groupWithTabs(g.id, deps, true);
        if (info) out.push(info);
      }
      return { groups: out };
    }
    case 'tabGroups.create': {
      const groupId = await t.group({ tabIds: a.tabIds! as [number, ...number[]] });
      const upd: chrome.tabGroups.UpdateProperties = {};
      if (typeof a.title === 'string') upd.title = a.title;
      if (typeof a.color === 'string') upd.color = a.color as chrome.tabGroups.Color;
      if (Object.keys(upd).length > 0) await ext().tabGroups.update(groupId, upd);
      return { group: await visibleGroup(groupId, deps) };
    }
    case 'tabGroups.update':
    case 'tabGroups.collapse': {
      const upd: chrome.tabGroups.UpdateProperties = {};
      if (typeof a.title === 'string') upd.title = a.title;
      if (typeof a.color === 'string') upd.color = a.color as chrome.tabGroups.Color;
      if (typeof a.collapsed === 'boolean') upd.collapsed = a.collapsed;
      await visibleGroup(a.groupId!, deps); // not_in_scope before anything changes
      await ext().tabGroups.update(a.groupId!, upd);
      return { group: await visibleGroup(a.groupId!, deps) };
    }
    case 'tabGroups.move': {
      const props: chrome.tabGroups.MoveProperties = { index: Number(a.index) };
      if (typeof a.windowId === 'number') props.windowId = a.windowId;
      await visibleGroup(a.groupId!, deps);
      await ext().tabGroups.move(a.groupId!, props);
      return { group: await visibleGroup(a.groupId!, deps) };
    }
    case 'tabGroups.ungroup':
      await t.ungroup(a.tabIds! as [number, ...number[]]);
      return {};
    case 'windows.list': {
      const wins = await ext().windows.getAll({ populate: true });
      const windows: WindowInfo[] = wins
        .filter((w) => !w.incognito && w.id !== undefined)
        .map((w) => ({
          windowId: w.id!,
          focused: w.focused,
          state: (w.state ?? 'normal') as WindowInfo['state'],
          type: (w.type ?? 'normal') as WindowInfo['type'],
          tabCount: w.tabs?.length ?? 0,
          incognito: false as const,
        }));
      return { windows };
    }
    default:
      throw new ControlError('not_supported', `unknown op ${op}`);
  }
}

/** `backstage.enter` (section 6 B2): a hidden tab, never `active: true`, never a window focus change. */
export async function openBackstageTab(url: string, windowId: number | undefined, deps: TabsDeps): Promise<chrome.tabs.Tab> {
  const href = assertNavigableUrl(url, deps.denyList());
  const props: chrome.tabs.CreateProperties = { url: href, active: false };
  if (windowId !== undefined) props.windowId = windowId;
  const tab = await ext().tabs.create(props);
  await deps.onCreated(tab, true);
  return tab;
}
