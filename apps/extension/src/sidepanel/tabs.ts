/**
 * Side panel tab list (section 7 "Tabs"): mirrored tabs with Pause / Resume, the REVEALED state with Hide again,
 * Share this tab too under `current_tab`, tabs opened by the technician, background tabs with Close / Close all,
 * and the count of protected tabs (never their names).
 */
import { ext } from '../shared/api';
import { button, clear, el } from '../shared/dom';
import type { UiSession } from '../shared/ui-state';
import { command } from '../ui/client';

export function renderTabs(root: HTMLElement, s: UiSession): void {
  clear(root);
  root.appendChild(el('h2', 'Shared tabs'));
  const list = el('ul', null, { class: 'list' });
  for (const t of s.tabs) {
    const li = el('li');
    const name = el('div', null, { class: 'grow' });
    name.appendChild(el('div', t.title ?? t.url ?? 'Untitled tab'));
    const notes: string[] = [];
    if (t.backstage) notes.push(`Background tab opened by ${s.assist}`);
    else if (t.createdByAssist) notes.push(`opened by ${s.assist}`);
    if (t.mirrored === 'paused') notes.push('Paused: not shared');
    if (t.mirrored === 'too_large') notes.push('Too large to mirror');
    if (t.mirrored === 'unsupported') notes.push('cannot be shared');
    if (notes.length > 0) name.appendChild(el('div', notes.join(' - '), { class: 'muted' }));
    li.appendChild(name);
    if (t.revealed !== 'none') {
      li.appendChild(el('span', 'REVEALED', { class: 'chip warn' }));
      li.appendChild(button('Hide again', () => void command({ t: 'ui.hideTab', tabId: t.tabId })));
    }
    if (t.mirrored === 'yes') li.appendChild(button('Pause', () => void command({ t: 'ui.pauseTab', tabId: t.tabId, paused: true })));
    if (t.mirrored === 'paused') li.appendChild(button('Resume', () => void command({ t: 'ui.pauseTab', tabId: t.tabId, paused: false })));
    if (t.backstage) li.appendChild(button('Close', () => void command({ t: 'ui.closeBackstage', tabId: t.tabId })));
    list.appendChild(li);
  }
  if (s.tabs.length === 0) list.appendChild(el('li', 'No tab is shared right now.', { class: 'muted' }));
  root.appendChild(list);
  if (s.backstageCount > 0) {
    const row = el('div', null, { class: 'row' });
    row.appendChild(el('span', `${s.backstageCount} background tab(s)`, { class: 'chip warn' }));
    row.appendChild(button('Close all', () => void command({ t: 'ui.closeBackstage', tabId: 'all' })));
    root.appendChild(row);
  }
  if (s.protectedCount > 0) root.appendChild(el('p', `${s.protectedCount} protected tabs are not shared`, { class: 'muted' }));
  if (s.scope === 'current_tab') {
    root.appendChild(
      button('Share this tab too', async () => {
        const [tab] = await ext().tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id !== undefined) await command({ t: 'ui.attachTab', tabId: tab.id });
      }),
    );
  }
}
