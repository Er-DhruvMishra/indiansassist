/**
 * Pure tab-strip state of the P2 console (Phase B 4.3, 4.5, 10.1). `mirror.tabs` replaces the list; `mirror.tab`
 * updates one entry and the tab's view state. Focus is owned by the Assist: the Desk's `activeTabId` only raises
 * the "User switched to ..." chip, never moves the focus.
 */
import type { TabInfo } from '@indiansassist/shared';

export type TabView = 'waiting' | 'live' | 'paused' | 'denied' | 'too_large' | 'detached' | 'unsupported' | 'not_in_scope';
export type TransportKind = 'dc' | 'relay';

export type TabsState = {
  tabs: TabInfo[];
  hiddenCount: number;
  /** The Desk's active tab (a dot on its chip). */
  activeTabId: number | null;
  /** The tab the Assist is viewing (`mirror.focus`). */
  focusedTabId: number | null;
  /** Set when the Desk switched tabs without a focus change (cleared by Follow or by focusing). */
  switchedTo: { tabId: number; title: string } | null;
  views: Record<number, TabView>;
  /** Too large only through the relay ("Too large to mirror through the server"). */
  tooLargeOnRelay: Record<number, boolean>;
};

export const EMPTY_TABS: TabsState = {
  tabs: [],
  hiddenCount: 0,
  activeTabId: null,
  focusedTabId: null,
  switchedTo: null,
  views: {},
  tooLargeOnRelay: {},
};

/** The view a tab's `mirrored` state implies before any snapshot arrived. */
export function viewFromInfo(t: TabInfo, current: TabView | undefined): TabView {
  switch (t.mirrored) {
    case 'yes':
      return current === 'live' ? 'live' : 'waiting';
    case 'paused':
      return 'paused';
    case 'denied':
      return 'denied';
    case 'too_large':
      return 'too_large';
    case 'not_in_scope':
      return 'not_in_scope';
    default:
      return 'unsupported';
  }
}

const titleOf = (t: TabInfo | undefined): string => t?.title ?? 'another tab';

function pickFocus(tabs: TabInfo[], current: number | null, active: number | null): number | null {
  if (current !== null && tabs.some((t) => t.tabId === current)) return current;
  const ok = tabs.filter((t) => t.mirrored === 'yes');
  return ok.find((t) => t.tabId === active)?.tabId ?? ok[0]?.tabId ?? tabs[0]?.tabId ?? null;
}

export function applyTabs(s: TabsState, msg: { tabs: TabInfo[]; hiddenCount: number; activeTabId: number | null; focusedTabId: number | null }): TabsState {
  const views: Record<number, TabView> = {};
  for (const t of msg.tabs) views[t.tabId] = viewFromInfo(t, s.views[t.tabId]);
  // The first list adopts the Desk's default focus (set once at consent.ok, section 4.3); later lists never move it.
  const focusedTabId = pickFocus(msg.tabs, s.focusedTabId ?? msg.focusedTabId, msg.activeTabId);
  let switchedTo = s.switchedTo;
  if (msg.activeTabId !== null && msg.activeTabId !== s.activeTabId && s.activeTabId !== null && msg.activeTabId !== focusedTabId) {
    switchedTo = { tabId: msg.activeTabId, title: titleOf(msg.tabs.find((t) => t.tabId === msg.activeTabId)) };
  }
  if (switchedTo && (!msg.tabs.some((t) => t.tabId === switchedTo!.tabId) || switchedTo.tabId === focusedTabId)) switchedTo = null;
  return { ...s, tabs: msg.tabs, hiddenCount: msg.hiddenCount, activeTabId: msg.activeTabId, focusedTabId, switchedTo, views };
}

export type MirrorTabState = 'attached' | 'detached' | 'paused' | 'resumed' | 'denied' | 'too_large' | 'navigated' | 'revealed' | 'restored';

export function applyTab(s: TabsState, tab: TabInfo, state: MirrorTabState, transport?: TransportKind): TabsState {
  const exists = s.tabs.some((t) => t.tabId === tab.tabId);
  let tabs = exists ? s.tabs.map((t) => (t.tabId === tab.tabId ? tab : t)) : [...s.tabs, tab];
  const views = { ...s.views };
  const tooLargeOnRelay = { ...s.tooLargeOnRelay };
  switch (state) {
    case 'detached':
      tabs = tabs.filter((t) => t.tabId !== tab.tabId);
      delete views[tab.tabId];
      break;
    case 'paused':
      views[tab.tabId] = 'paused';
      break;
    case 'denied':
      views[tab.tabId] = 'denied';
      break;
    case 'too_large':
      views[tab.tabId] = 'too_large';
      tooLargeOnRelay[tab.tabId] = transport === 'relay';
      break;
    case 'attached':
    case 'resumed':
    case 'navigated':
      // A fresh snapshot follows (section 4.4); until it is applied the tab waits.
      views[tab.tabId] = 'waiting';
      delete tooLargeOnRelay[tab.tabId];
      break;
    default:
      views[tab.tabId] = viewFromInfo(tab, views[tab.tabId]);
  }
  const focusedTabId = pickFocus(tabs, s.focusedTabId, s.activeTabId);
  return { ...s, tabs, views, tooLargeOnRelay, focusedTabId };
}

export function setFocus(s: TabsState, tabId: number): TabsState {
  return { ...s, focusedTabId: tabId, switchedTo: s.switchedTo?.tabId === tabId ? null : s.switchedTo };
}

export function markLive(s: TabsState, tabId: number): TabsState {
  if (s.views[tabId] === 'live') return s;
  return { ...s, views: { ...s.views, [tabId]: 'live' } };
}

/** After a link rebuild every live tab waits for its fresh snapshot (the replayer keeps the last frame meanwhile). */
export function markAllWaiting(s: TabsState): TabsState {
  const views: Record<number, TabView> = {};
  for (const [k, v] of Object.entries(s.views)) views[Number(k)] = v === 'live' ? 'waiting' : v;
  return { ...s, views };
}

/** Chip badges for a tab (section 10.1). */
export function tabBadges(t: TabInfo, view: TabView | undefined): string[] {
  const out: string[] = [];
  if (t.mirrored === 'paused' || view === 'paused') out.push('paused');
  if (t.mirrored === 'denied') out.push('protected');
  if (t.mirrored === 'too_large' || view === 'too_large') out.push('too large');
  if (t.mirrored === 'not_in_scope' || t.mirrored === 'unsupported') out.push('not shared');
  if (t.backstage) out.push('background');
  if (t.revealed !== 'none') out.push('revealed');
  if (t.createdByAssist) out.push('opened by you');
  return out;
}

/** The placeholder text of the replayer host for a view (null = show the replayer). */
export function placeholderFor(view: TabView | undefined, onRelay: boolean): string | null {
  switch (view) {
    case undefined:
      return 'No shared tab yet.';
    case 'waiting':
      return 'Waiting for snapshot';
    case 'paused':
      return 'Paused by the user';
    case 'denied':
      return 'Protected page';
    case 'too_large':
      return onRelay ? 'Too large to mirror through the server' : 'Too large to mirror';
    case 'not_in_scope':
    case 'unsupported':
      return 'This tab is not shared';
    case 'detached':
      return 'This tab is no longer shared';
    default:
      return null;
  }
}
