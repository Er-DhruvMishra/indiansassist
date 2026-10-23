/**
 * Tab control panel (Phase B 5.3, 10.1): new tab, activate, close, reload, navigate (http(s) only, checked here
 * too), pin, mute, move, and tab groups (list, create, rename / colour, collapse, ungroup). Every button is
 * disabled below `tab_control` with a tooltip naming the level.
 */
import { useState, type FormEvent } from 'react';
import { TAB_GROUP_COLORS, groupInfoSchema, type ControlOp, type GroupInfo, type TabInfo } from '@indiansassist/shared';
import { Button, Input, Select } from '../../../components/ui';
import type { ControlResult } from './controlClient';
import { normaliseNavUrl } from './controlBuilders';

type OpFn = (op: ControlOp, args: Record<string, unknown>, okText?: string) => Promise<ControlResult>;

const NEED = 'Needs the "Switch and open tabs" level';

export function TabControlPanel({ tab, canTab, onOp }: { tab: TabInfo | null; canTab: boolean; onOp: OpFn }) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [index, setIndex] = useState('0');
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupColor, setGroupColor] = useState<(typeof TAB_GROUP_COLORS)[number]>('blue');
  const off = !canTab;
  const noTab = off || !tab;
  const tip = off ? NEED : undefined;
  const content = tab ? tab.mirrored !== 'denied' : false;

  const go = (create: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    const u = normaliseNavUrl(url);
    if (!u) return setUrlError('Enter an http or https address.');
    setUrlError(null);
    if (create) void onOp('tabs.create', { url: u }, 'Tab opened on the Desk.');
    else if (tab) void onOp('tabs.navigate', { tabId: tab.tabId, url: u }, 'Navigated.');
  };

  const loadGroups = async () => {
    const r = await onOp('tabGroups.list', {}, 'Groups loaded.');
    if (!r.ok) return;
    const list = Array.isArray(r.result.groups) ? r.result.groups : [];
    setGroups(list.flatMap((g) => {
      const p = groupInfoSchema.safeParse(g);
      return p.success ? [p.data] : [];
    }));
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
      <div className="flex items-end gap-1">
        <div className="flex flex-col gap-1">
          <label htmlFor="ia-tab-index" className="text-xs font-medium">
            Move to position
          </label>
          <Input id="ia-tab-index" type="number" min={-1} value={index} onChange={(e) => setIndex(e.target.value)} disabled={noTab} className="w-24" />
        </div>
        <Button size="sm" variant="secondary" disabled={noTab} title={tip} onClick={() => tab && void onOp('tabs.move', { tabIds: [tab.tabId], index: Number.parseInt(index, 10) || 0 }, 'Moved.')}>
          Move
        </Button>
      </div>
      <fieldset className="flex flex-col gap-2 rounded-md border border-slate-300 p-2 dark:border-slate-700">
        <legend className="px-1 text-sm font-medium">Tab groups</legend>
        <div className="flex flex-wrap items-end gap-1">
          <Input aria-label="Group title" placeholder="Group title" value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} disabled={noTab} className="w-36" />
          <Select aria-label="Group colour" value={groupColor} onChange={(e) => setGroupColor(e.target.value as typeof groupColor)} disabled={noTab}>
            {TAB_GROUP_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="secondary" disabled={noTab} title={tip} onClick={() => tab && void onOp('tabGroups.create', { tabIds: [tab.tabId], color: groupColor, ...(groupTitle.trim() ? { title: groupTitle.trim() } : {}) }, 'Group created.')}>
            Group this tab
          </Button>
          <Button size="sm" variant="secondary" disabled={noTab || tab?.groupId === -1} title={tip} onClick={() => tab && void onOp('tabGroups.ungroup', { tabIds: [tab.tabId] }, 'Ungrouped.')}>
            Ungroup
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void loadGroups()}>
            List groups
          </Button>
        </div>
        {groups && groups.length === 0 && <p className="text-xs">No tab groups.</p>}
        {groups && groups.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {groups.map((g) => (
              <li key={g.groupId} className="flex flex-wrap items-center gap-1">
                <span className="font-medium">{g.title || 'Untitled group'}</span>
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  ({g.color}, {g.tabIds.length} tabs{g.collapsed ? ', collapsed' : ''})
                </span>
                <Button size="sm" variant="ghost" disabled={off} title={tip} onClick={() => void onOp('tabGroups.collapse', { groupId: g.groupId, collapsed: !g.collapsed }, g.collapsed ? 'Expanded.' : 'Collapsed.').then(() => loadGroups())}>
                  {g.collapsed ? 'Expand' : 'Collapse'}
                </Button>
                <Button size="sm" variant="ghost" disabled={off || !groupTitle.trim()} title={tip} onClick={() => void onOp('tabGroups.update', { groupId: g.groupId, title: groupTitle.trim(), color: groupColor }, 'Group updated.').then(() => loadGroups())}>
                  Rename / recolour
                </Button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
    </section>
  );
}
