/**
 * Per-tab sharing state and the `TabInfo` the Assist sees (sections 4.1, 4.5, 6, 8.2). Scope is applied before the
 * scheme and the deny list: under `current_tab` every tab the Desk did not share is `not_in_scope`, whatever its URL
 * (SEC-P2-03), so nothing about it reaches the Assist. Denied and out-of-scope tabs disclose no title, url or
 * favicon; `unsupported` tabs (non-http schemes) disclose only a reduced url (`unsupportedUrl`) and, for browser
 * pages, the title (prd-F6). With scope `current_tab` only mirrored, Assist-created and backstage tabs are listed;
 * `hiddenCount` carries the rest.
 */
import { isMirrorableUrl, matchesDenyList, stripUrlForMirror, hostOf, type MirrorScope, type TabInfo } from '@indiansassist/shared';
import type { TabState } from '../shared/storage';

export const SHARED_PREFIX = '(Shared) ';

export function stripSharedPrefix(title: string | undefined | null): string | null {
  if (title === undefined || title === null) return null;
  let t = title;
  while (t.startsWith(SHARED_PREFIX)) t = t.slice(SHARED_PREFIX.length);
  return t.slice(0, 2000);
}

export type UrlClass = 'ok' | 'denied' | 'unsupported';

/** Scheme check first (`unsupported`), then the deny list (`denied`). */
export function classifyUrl(url: string | undefined | null, denyList: readonly string[]): UrlClass {
  if (!url || !isMirrorableUrl(url)) return 'unsupported';
  return matchesDenyList(url, denyList) ? 'denied' : 'ok';
}

/** Scope first: a tab outside the shared scope is `not_in_scope` whatever its scheme or host. */
function mirroredFor(cls: UrlClass, inScope: boolean): TabState['mirrored'] {
  if (!inScope) return 'not_in_scope';
  if (cls === 'unsupported') return 'unsupported';
  return cls === 'denied' ? 'denied' : 'yes';
}

export type NewTabOpts = { inScope: boolean; createdByAssist?: boolean; backstage?: boolean; now?: number };

/** The state of a tab that enters the registry (consent, tab created, attach). */
export function initialTabState(url: string | undefined, denyList: readonly string[], scope: MirrorScope, o: NewTabOpts): TabState {
  const cls = classifyUrl(url, denyList);
  const createdByAssist = o.createdByAssist ?? false;
  const backstage = o.backstage ?? false;
  const inScope = scope === 'all_tabs' || o.inScope || createdByAssist || backstage;
  const mirrored = mirroredFor(cls, inScope);
  return {
    mirrored,
    paused: false,
    inScope,
    backstage,
    createdByAssist,
    enteredAt: o.now ?? Date.now(),
    injected: false,
    host: cls === 'ok' ? hostOf(url!) : null,
  };
}

/** Re-classifies a tab after it navigated (a redirect into a denied host makes it `denied`, section 5.2). */
export function afterNavigation(st: TabState, url: string | undefined, denyList: readonly string[], scope: MirrorScope): TabState {
  const cls = classifyUrl(url, denyList);
  const inScope = scope === 'all_tabs' || st.inScope;
  const mirrored = mirroredFor(cls, inScope); // `paused` stays a separate flag; too_large is retried
  const out: TabState = { ...st, mirrored, host: cls === 'ok' ? hostOf(url!) : null, injected: false };
  delete out.reveal;
  delete out.error;
  return out;
}

/** `mirrored` states whose content the Assist may see (or did see). */
export function isVisibleState(m: TabState['mirrored']): boolean {
  return m === 'yes' || m === 'paused' || m === 'too_large';
}

/** Whether the Assist sees this tab at all (listed in `mirror.tabs` / `tabs.list`) under `scope`. */
export function isListedFor(st: TabState | undefined, scope: MirrorScope): boolean {
  if (!st) return false;
  if (scope === 'all_tabs') return true;
  return isVisibleState(st.mirrored) || st.createdByAssist || st.backstage;
}

const BROWSER_PAGE_SCHEMES = new Set(['chrome:', 'edge:', 'brave:', 'opera:', 'vivaldi:']);

/**
 * What an `unsupported` tab may disclose (prd-F6). An http(s) page that refused the script (`inject_failed`) is an
 * ordinary shared page. Browser pages keep `scheme://host/` (`chrome://settings/`) and their title; `about:` keeps
 * its opaque name; an extension page keeps its origin; every other scheme (`file:`, `data:`, `blob:`,
 * `view-source:`, ...) only its scheme, because the path or body is the user's data (file names, user names).
 */
export function unsupportedUrl(url: string): { url: string | null; showTitle: boolean } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url: null, showTitle: false };
  }
  if (isMirrorableUrl(url)) return { url: stripUrlForMirror(url), showTitle: true };
  if (BROWSER_PAGE_SCHEMES.has(u.protocol)) return { url: `${u.protocol}//${u.host}/`, showTitle: true };
  if (u.protocol === 'about:') return { url: `about:${u.pathname}`, showTitle: false };
  if (u.protocol === 'chrome-extension:' || u.protocol === 'extension:') return { url: `${u.protocol}//${u.host}/`, showTitle: false };
  return { url: u.protocol, showTitle: false };
}

export function toTabInfo(tab: chrome.tabs.Tab, st: TabState | undefined, favicon: string | null): TabInfo | null {
  if (tab.id === undefined || tab.id < 0 || tab.incognito) return null;
  const mirrored = st?.mirrored ?? 'not_in_scope';
  const hidden = mirrored === 'denied' || mirrored === 'not_in_scope';
  const unsupported = mirrored === 'unsupported';
  const url = tab.url ?? tab.pendingUrl ?? null;
  const reduced = unsupported && url ? unsupportedUrl(url) : null;
  const info: TabInfo = {
    tabId: tab.id,
    windowId: tab.windowId,
    index: Math.max(0, tab.index),
    title: hidden || (reduced && !reduced.showTitle) ? null : stripSharedPrefix(tab.title),
    url: hidden || !url ? null : reduced ? reduced.url : stripUrlForMirror(url),
    favicon: hidden || unsupported ? null : favicon,
    active: tab.active,
    pinned: tab.pinned,
    muted: tab.mutedInfo?.muted ?? false,
    audible: tab.audible ?? false,
    groupId: tab.groupId ?? -1,
    status: tab.status === 'loading' ? 'loading' : 'complete',
    mirrored: st?.paused && mirrored === 'yes' ? 'paused' : mirrored,
    backstage: st?.backstage ?? false,
    createdByAssist: st?.createdByAssist ?? false,
    revealed: st?.reveal?.scope ?? 'none',
    discarded: tab.discarded ?? false,
  };
  if (st?.error) info.error = st.error;
  return info;
}

/** The tab list for the Assist (`mirror.tabs`, `tabs.list`) and the number of tabs it does not see. */
export function listForAssist(infos: TabInfo[], scope: MirrorScope): { tabs: TabInfo[]; hiddenCount: number } {
  if (scope === 'all_tabs') return { tabs: infos, hiddenCount: 0 };
  const tabs = infos.filter((t) => isVisibleState(t.mirrored) || t.createdByAssist || t.backstage);
  return { tabs, hiddenCount: infos.length - tabs.length };
}

/**
 * `tabs.query` (section 5.3): the candidate set is first reduced to `yes` / `paused` / `too_large` tabs, then
 * filtered, so `urlHost` can never confirm a protected tab.
 */
export function queryTabs(
  infos: TabInfo[],
  hosts: Map<number, string | null>,
  f: { windowId?: number; groupId?: number; active?: boolean; pinned?: boolean; audible?: boolean; urlHost?: string },
): { tabs: TabInfo[]; hiddenCount: number } {
  const candidates = infos.filter((t) => isVisibleState(t.mirrored));
  const hiddenCount = infos.length - candidates.length;
  const host = f.urlHost?.toLowerCase();
  const tabs = candidates.filter(
    (t) =>
      (f.windowId === undefined || t.windowId === f.windowId) &&
      (f.groupId === undefined || t.groupId === f.groupId) &&
      (f.active === undefined || t.active === f.active) &&
      (f.pinned === undefined || t.pinned === f.pinned) &&
      (f.audible === undefined || t.audible === f.audible) &&
      (host === undefined || hosts.get(t.tabId) === host),
  );
  return { tabs, hiddenCount };
}
