/**
 * An in-memory `chrome` API fake for the extension tests (section 9.5): storage areas, runtime messaging, tabs,
 * tab groups, windows, scripting, debugger, permissions, action, alarms, side panel and offscreen. Every method
 * is a `vi.fn` so tests can assert calls; state lives in plain maps.
 */
import { vi } from 'vitest';

export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

type Listener = (...args: never[]) => unknown;
function event() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: vi.fn((l: Listener) => void listeners.add(l)),
    removeListener: vi.fn((l: Listener) => void listeners.delete(l)),
    hasListener: (l: Listener) => listeners.has(l),
    fire: (...args: unknown[]) => [...listeners].map((l) => (l as (...a: unknown[]) => unknown)(...args)),
  };
}

function area(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
    setAccessLevel: vi.fn(async () => undefined),
  };
}

export type FakeTab = chrome.tabs.Tab;

export function makeTab(id: number, url: string, extra: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title: `Tab ${id}`,
    active: false,
    pinned: false,
    highlighted: false,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    status: 'complete',
    frozen: false,
    ...extra,
  } as chrome.tabs.Tab;
}

export function installChromeMock(opts: { tabs?: chrome.tabs.Tab[]; managed?: Record<string, unknown> } = {}) {
  const tabs = new Map<number, chrome.tabs.Tab>((opts.tabs ?? []).map((t) => [t.id!, t]));
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  let nextTab = 1000;
  let nextGroup = 50;
  const permissions = new Set<string>();
  const runtimeSent: unknown[] = [];
  const tabSent: { tabId: number; msg: unknown }[] = [];
  const onMessage = event();
  const mock = {
    tabsStore: tabs,
    groupsStore: groups,
    permissionsSet: permissions,
    runtimeSent,
    tabSent,
    /** Answers `chrome.tabs.sendMessage` (content script replies). */
    tabReply: vi.fn((_tabId: number, _msg: unknown): unknown => undefined),
    /** Answers `chrome.runtime.sendMessage` (offscreen / worker replies). */
    runtimeReply: vi.fn((_msg: unknown): unknown => ({ ok: true })),
    storage: { local: area(), session: area(), managed: area(opts.managed ?? {}) },
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}`,
      sendMessage: vi.fn(async (msg: unknown) => {
        runtimeSent.push(msg);
        return mock.runtimeReply(msg);
      }),
      onMessage,
      onMessageExternal: event(),
      onConnect: event(),
      onInstalled: event(),
      connect: vi.fn(),
      openOptionsPage: vi.fn(),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      }),
      query: vi.fn(async (q: chrome.tabs.QueryInfo = {}) =>
        [...tabs.values()].filter(
          (t) =>
            (q.active === undefined || t.active === q.active) &&
            (q.windowId === undefined || t.windowId === q.windowId) &&
            (q.groupId === undefined || t.groupId === q.groupId),
        ),
      ),
      create: vi.fn(async (p: chrome.tabs.CreateProperties) => {
        const t = makeTab(nextTab++, p.url ?? 'chrome://newtab/', { active: p.active ?? true, windowId: p.windowId ?? 1, pinned: p.pinned ?? false, status: 'loading' });
        tabs.set(t.id!, t);
        return { ...t };
      }),
      update: vi.fn(async (id: number, p: chrome.tabs.UpdateProperties) => {
        const t = tabs.get(id);
        if (!t) throw new Error('No tab');
        if (p.url) t.url = p.url;
        if (p.active !== undefined) t.active = p.active;
        if (p.pinned !== undefined) t.pinned = p.pinned;
        if (p.muted !== undefined) t.mutedInfo = { muted: p.muted };
        return { ...t };
      }),
      remove: vi.fn(async (id: number | number[]) => {
        for (const i of Array.isArray(id) ? id : [id]) {
          if (!tabs.delete(i)) throw new Error('No tab');
        }
      }),
      reload: vi.fn(async () => undefined),
      move: vi.fn(async (ids: number | number[], p: { index: number }) => (Array.isArray(ids) ? ids : [ids]).map((i, n) => ({ ...tabs.get(i)!, index: p.index + n }))),
      group: vi.fn(async (o: { tabIds: number[] }) => {
        const id = nextGroup++;
        groups.set(id, { id, windowId: 1, title: '', color: 'grey', collapsed: false } as chrome.tabGroups.TabGroup);
        for (const t of o.tabIds) tabs.get(t)!.groupId = id;
        return id;
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const t of ids) tabs.get(t)!.groupId = -1;
      }),
      sendMessage: vi.fn(async (tabId: number, msg: unknown) => {
        tabSent.push({ tabId, msg });
        return mock.tabReply(tabId, msg);
      }),
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onActivated: event(),
    },
    tabGroups: {
      get: vi.fn(async (id: number) => {
        const g = groups.get(id);
        if (!g) throw new Error('No group');
        return { ...g };
      }),
      query: vi.fn(async () => [...groups.values()]),
      update: vi.fn(async (id: number, p: chrome.tabGroups.UpdateProperties) => Object.assign(groups.get(id)!, p)),
      move: vi.fn(async (id: number) => groups.get(id)),
    },
    windows: {
      create: vi.fn(async () => ({ id: 77 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => undefined),
      getAll: vi.fn(async () => [
        { id: 1, focused: true, state: 'normal', type: 'normal', incognito: false, tabs: [...tabs.values()] },
        { id: 2, focused: false, state: 'normal', type: 'normal', incognito: true, tabs: [] },
      ]),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onRemoved: event(),
    },
    scripting: {
      registerContentScripts: vi.fn(async () => undefined),
      unregisterContentScripts: vi.fn(async () => undefined),
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onDetach: event(),
    },
    permissions: {
      contains: vi.fn(async (p: { permissions?: string[] }) => (p.permissions ?? []).every((x) => permissions.has(x))),
      request: vi.fn(async (p: { permissions?: string[] }) => {
        for (const x of p.permissions ?? []) permissions.add(x);
        return true;
      }),
      remove: vi.fn(async (p: { permissions?: string[] }) => {
        for (const x of p.permissions ?? []) permissions.delete(x);
        return true;
      }),
      onAdded: event(),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
      setIcon: vi.fn(async () => undefined),
    },
    alarms: {
      create: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
      onAlarm: event(),
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined), setOptions: vi.fn(async () => undefined), open: vi.fn(async () => undefined) },
    offscreen: { createDocument: vi.fn(async () => undefined), closeDocument: vi.fn(async () => undefined) },
  };
  (globalThis as { chrome?: unknown }).chrome = mock;
  return mock;
}

export type ChromeMock = ReturnType<typeof installChromeMock>;

/** Messages the worker sent to the offscreen document, by `t`. */
export function offscreenSent(m: ChromeMock, t?: string): Record<string, unknown>[] {
  return (m.runtimeSent as Record<string, unknown>[]).filter((x) => x.to === 'offscreen' && (t === undefined || x.t === t));
}
