/**
 * Tab groups part of the tab control panel (Phase B 5.3, 10.1): create from the focused tab, ungroup, list, and per
 * listed group collapse / expand, rename / recolour and **Move group** (`tabGroups.move` to the position and window
 * chosen in the panel's Move row). Every action is disabled below `tab_control`.
 */
import { useState } from 'react';
import { TAB_GROUP_COLORS, groupInfoSchema, type GroupInfo, type TabInfo } from '@indiansassist/shared';
import { Button, Input, Select } from '../../../components/ui';
import type { OpFn } from './TabControlPanel';

export type MoveTarget = { index: number; windowId: number | null };

export function TabGroupsSection({ tab, off, tip, onOp, target }: { tab: TabInfo | null; off: boolean; tip?: string; onOp: OpFn; target: MoveTarget }) {
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupColor, setGroupColor] = useState<(typeof TAB_GROUP_COLORS)[number]>('blue');
  const noTab = off || !tab;

  const loadGroups = async () => {
    const r = await onOp('tabGroups.list', {}, 'Groups loaded.');
    if (!r.ok) return;
    const list = Array.isArray(r.result.groups) ? r.result.groups : [];
    setGroups(list.flatMap((g) => {
      const p = groupInfoSchema.safeParse(g);
      return p.success ? [p.data] : [];
    }));
  };

  const moveGroup = (g: GroupInfo) =>
    void onOp('tabGroups.move', { groupId: g.groupId, index: target.index, ...(target.windowId !== null ? { windowId: target.windowId } : {}) }, 'Group moved.').then(() => loadGroups());

  return (
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
              <Button size="sm" variant="ghost" disabled={off} title={tip ?? 'Moves the group to the position and window chosen under Move'} aria-label={`Move group ${g.title || 'Untitled group'}`} onClick={() => moveGroup(g)}>
                Move group
              </Button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
