/**
 * Tab control panel (Phase B 5.3, 10.1): new tab, activate, close, reload, navigate (http(s) only, checked here
 * too), pin, mute, move (position and, from `windows.list`, target window: `tabs.move`), and tab groups
 * (`TabGroupsSection`: list, create, rename / colour, collapse, ungroup, move). Every button is disabled below
 * `tab_control` with a tooltip naming the level.
 */
import { useState, type FormEvent } from 'react';
import { windowInfoSchema, type ControlOp, type TabInfo, type WindowInfo } from '@indiansassist/shared';
import { Button, Input, Select } from '../../../components/ui';
import type { ControlResult } from './controlClient';
import { normaliseNavUrl } from './controlBuilders';
import { TabGroupsSection, type MoveTarget } from './TabGroupsSection';

export type OpFn = (op: ControlOp, args: Record<string, unknown>, okText?: string) => Promise<ControlResult>;

const NEED = 'Needs the "Switch and open tabs" level';

/** The op catalogue's `index` range (-1 = end). */
export function parseMoveIndex(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(10_000, Math.max(-1, n)) : 0;
}

export function windowLabel(w: WindowInfo): string {
  const kind = w.type === 'normal' ? 'Window' : `${w.type[0]!.toUpperCase()}${w.type.slice(1)} window`;
  const extra = `${w.focused ? ', in front' : ''}${w.state === 'minimized' ? ', minimised' : ''}`;
  return `${kind} ${w.windowId} (${w.tabCount} tab${w.tabCount === 1 ? '' : 's'}${extra})`;
}

export function TabControlPanel({ tab, canTab, onOp }: { tab: TabInfo | null; canTab: boolean; onOp: OpFn }) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [index, setIndex] = useState('0');
  const [windows, setWindows] = useState<WindowInfo[] | null>(null);
  const [windowSel, setWindowSel] = useState('');
  const off = !canTab;
  const noTab = off || !tab;
  const tip = off ? NEED : undefined;
  const content = tab ? tab.mirrored !== 'denied' : false;
  const target: MoveTarget = { index: parseMoveIndex(index), windowId: windowSel === '' ? null : Number(windowSel) };

  const go = (create: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    const u = normaliseNavUrl(url);
    if (!u) return setUrlError('Enter an http or https address.');
    setUrlError(null);
    if (create) void onOp('tabs.create', { url: u }, 'Tab opened on the Desk.');
    else if (tab) void onOp('tabs.navigate', { tabId: tab.tabId, url: u }, 'Navigated.');
  };

  const loadWindows = async () => {
    const r = await onOp('windows.list', {}, 'Windows loaded.');
    if (!r.ok) return;
    const list = Array.isArray(r.result.windows) ? r.result.windows : [];
    const next = list.flatMap((w) => {
      const p = windowInfoSchema.safeParse(w);
      return p.success ? [p.data] : [];
    });
    setWindows(next);
    if (windowSel !== '' && !next.some((w) => String(w.windowId) === windowSel)) setWindowSel('');
  };

  return (
    <section aria-label="Tab control" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Tabs</h2>
      <form onSubmit={go(false)} className="flex flex-col gap-1" noValidate>
        <label htmlFor="ia-tab-url" className="text-sm font-medium">
          Address
        </label>
        <div className="flex gap-1">
          <Input id="ia-tab-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" disabled={off} aria-invalid={urlError !== null} />
        </div>
        {urlError && <p className="text-xs font-medium text-red-700 dark:text-red-400">{urlError}</p>}
        <div className="flex flex-wrap gap-1">
          <Button size="sm" type="submit" disabled={noTab || !content} title={tip}>
            Navigate this tab
          </Button>
          <Button size="sm" variant="secondary" onClick={() => go(true)()} disabled={off} title={tip}>
            Open in new tab
          </Button>
        </div>
      </form>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" disabled={noTab || tab?.backstage} title={tip} onClick={() => tab && void onOp('tabs.activate', { tabId: tab.tabId }, 'Switched the Desk to this tab.')}>
          Show on Desk
        </Button>
        <Button size="sm" variant="secondary" disabled={noTab || !content} title={tip} onClick={() => tab && void onOp('tabs.reload', { tabId: tab.tabId }, 'Reloaded.')}>
          Reload
        </Button>
        <Button size="sm" variant="secondary" disabled={noTab} title={tip} onClick={() => tab && void onOp('tabs.pin', { tabId: tab.tabId, pinned: !tab.pinned }, tab.pinned ? 'Unpinned.' : 'Pinned.')}>
          {tab?.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Button size="sm" variant="secondary" disabled={noTab} title={tip} onClick={() => tab && void onOp('tabs.mute', { tabId: tab.tabId, muted: !tab.muted }, tab.muted ? 'Unmuted.' : 'Muted.')}>
          {tab?.muted ? 'Unmute' : 'Mute'}
        </Button>
        <Button size="sm" variant="danger" disabled={noTab} title={tip} onClick={() => tab && void onOp('tabs.close', { tabIds: [tab.tabId] }, 'Tab closed.')}>
          Close tab
        </Button>
      </div>
      <fieldset className="flex flex-col gap-1 rounded-md border border-slate-300 p-2 dark:border-slate-700">
        <legend className="px-1 text-sm font-medium">Move</legend>
        <div className="flex flex-wrap items-end gap-1">
          <div className="flex flex-col gap-1">
            <label htmlFor="ia-tab-index" className="text-xs font-medium">
              Move to position
            </label>
            <Input id="ia-tab-index" type="number" min={-1} value={index} onChange={(e) => setIndex(e.target.value)} disabled={off} className="w-24" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="ia-tab-window" className="text-xs font-medium">
              Window
            </label>
            <Select id="ia-tab-window" value={windowSel} onChange={(e) => setWindowSel(e.target.value)} disabled={off}>
              <option value="">Same window</option>
              {(windows ?? []).map((w) => (
                <option key={w.windowId} value={String(w.windowId)}>
                  {windowLabel(w)}
                </option>
              ))}
            </Select>
          </div>
          <Button size="sm" variant="ghost" disabled={off} title={tip} onClick={() => void loadWindows()}>
            List windows
          </Button>
          <Button size="sm" variant="secondary" disabled={noTab} title={tip} onClick={() => tab && void onOp('tabs.move', { tabIds: [tab.tabId], index: target.index, ...(target.windowId !== null ? { windowId: target.windowId } : {}) }, 'Moved.')}>
            Move tab
          </Button>
        </div>
        {windows && windows.length === 0 && <p className="text-xs">No windows listed.</p>}
      </fieldset>
      <TabGroupsSection tab={tab} off={off} tip={tip} onOp={onOp} target={target} />
    </section>
  );
}
