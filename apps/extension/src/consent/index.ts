/**
 * The consent window (section 3.1): who asks, what to share (this tab with a picker, or all tabs), background tabs,
 * the level (only levels within `effectiveMaxLevel`), the masking explanation, Share / Decline. Choosing deep
 * control requests the `debugger` permission on the Share click; a refusal downgrades to `in_page`. Share opens
 * the side panel for the chosen tab's window (the click is a user gesture) before telling the worker.
 */
import '../ui/styles.css';
import { CONSENT_LEVELS, CONSENT_LEVEL_ORDER, isMirrorableUrl, matchesDenyList, type ConsentLevel } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { append, button, clear, el } from '../shared/dom';
import type { ConsentInfo, UiState } from '../shared/ui-state';
import { command, requestDebugger, subscribe } from '../ui/client';

const LEVEL_TEXT: Record<ConsentLevel, string> = {
  view: 'View only',
  tab_control: 'Let them switch and open tabs',
  in_page: 'Let them click and type in shared pages',
  deep_control: 'Deep control (Chrome will show a debugging bar, and will ask you to allow it every session)',
};

const main = document.getElementById('app')!;
let built = false;
let answered = false;

function radio(name: string, value: string, label: string, checked: boolean, disabled = false): HTMLLabelElement {
  const id = `${name}-${value}`;
  const input = el('input', null, { type: 'radio', name, value, id, checked, disabled });
  const l = el('label', null, { for: id, class: disabled ? 'disabled' : undefined });
  l.append(input, el('span', label));
  return l;
}

function picked(name: string): string | null {
  return (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value ?? null;
}

async function build(info: ConsentInfo): Promise<void> {
  built = true;
  clear(main);
  const who = el('section', null, { class: 'card' });
  const head = el('div', null, { class: 'row' });
  if (info.org.logoData?.startsWith('data:image/')) {
    const img = el('img', null, { class: 'logo', alt: '' });
    img.src = info.org.logoData;
    head.appendChild(img);
  }
  head.appendChild(el('h1', `${info.technician} wants to see your browser`));
  who.append(head, el('p', info.org.displayName, { class: 'muted' }));

  const scope = el('fieldset');
  scope.appendChild(el('legend', 'What to share'));
  scope.appendChild(radio('scope', 'current_tab', 'This tab only', true));
  const tabs = await ext().tabs.query({ windowType: 'normal' });
  const picker = el('select', null, { 'aria-label': 'Tab to share', id: 'tab' });
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const url = t.url ?? '';
    const denied = isMirrorableUrl(url) && matchesDenyList(url, info.denyHosts);
    const unsupported = !isMirrorableUrl(url);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      host = '';
    }
    const label = `${(t.title ?? 'Untitled').slice(0, 60)}${host ? ` - ${host}` : ''}${denied ? ' (protected)' : unsupported ? ' (cannot be shared)' : ''}`;
    const o = el('option', label, { value: t.id, disabled: denied || unsupported });
    o.selected = t.id === info.candidateTabId && !denied && !unsupported;
    picker.appendChild(o);
  }
  scope.appendChild(picker);
  if (info.allowAllTabs) scope.appendChild(radio('scope', 'all_tabs', 'All my tabs', false));
  scope.appendChild(el('p', 'Tabs on protected sites are never shared.', { class: 'muted' }));
  const which = el('details');
  which.appendChild(el('summary', 'Which sites?'));
  which.appendChild(el('p', info.denyHosts.join(', '), { class: 'muted' }));
  scope.appendChild(which);

  const bg = el('input', null, { type: 'checkbox', id: 'bg' });
  const bgLabel = el('label', null, { for: 'bg', class: info.backstageAllowed ? undefined : 'hidden' });
  bgLabel.append(bg, el('span', 'Allow the technician to open background tabs (you can close them any time)'));
  const checklist = el('input', null, { type: 'checkbox', id: 'closed' });
  const checkLabel = el('label', null, { for: 'closed', class: 'hidden' });
  checkLabel.append(checklist, el('span', 'I have closed tabs I do not want to share'));
  scope.append(bgLabel, checkLabel);
  scope.addEventListener('change', () => {
    const all = picked('scope') === 'all_tabs';
    picker.disabled = all;
    checkLabel.classList.toggle('hidden', !all);
    if (info.backstageAllowed) bg.checked = all;
  });

  const level = el('fieldset');
  level.appendChild(el('legend', 'What they can do'));
  for (const lv of CONSENT_LEVELS) {
    if (CONSENT_LEVEL_ORDER[lv] > CONSENT_LEVEL_ORDER[info.maxLevel]) continue;
    level.appendChild(radio('level', lv, LEVEL_TEXT[lv], lv === info.defaultLevel));
  }
  const notice = el('p', null, { class: 'error', role: 'alert' });
  const mask = el('p', 'Passwords and fields marked sensitive are hidden from the technician. They can ask you to reveal a field for up to a minute; you decide each time and can hide it again.', { class: 'muted' });
  const limited = info.managedLimited ? el('p', "Some options are limited by your organisation's policy.", { class: 'muted' }) : null;

  const share = button('Share', async () => {
    const sc = picked('scope') === 'all_tabs' ? 'all_tabs' : 'current_tab';
    if (sc === 'all_tabs' && !checklist.checked) {
      notice.textContent = 'Please confirm you have closed the tabs you do not want to share.';
      return;
    }
    let lv = (picked('level') ?? info.defaultLevel) as ConsentLevel;
    if (lv === 'deep_control' && !(await requestDebugger())) {
      lv = 'in_page';
      notice.textContent = 'Chrome did not allow deep control; sharing with "click and type" instead.';
    }
    const tabId = sc === 'current_tab' && picker.value ? Number(picker.value) : null;
    const tab = tabId !== null ? tabs.find((t) => t.id === tabId) : tabs.find((t) => t.active);
    if (tab?.windowId !== undefined) await ext().sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    answered = true;
    await command({ t: 'ui.consent', decision: 'share', level: lv, scope: sc, backstage: info.backstageAllowed && bg.checked, tabId });
    window.close();
  }, { class: 'primary' });
  const decline = button('Decline', () => void doDecline());
  const row = el('div', null, { class: 'row' });
  row.append(share, decline);
  const maskCard = el('section', null, { class: 'card' });
  maskCard.append(mask);
  if (limited) maskCard.append(limited);
  append(main, who, scope, level, maskCard, notice);
  main.appendChild(row);
}

async function doDecline(): Promise<void> {
  if (answered) return;
  answered = true;
  await command({ t: 'ui.consent', decision: 'decline', level: 'view', scope: 'current_tab', backstage: false, tabId: null });
  window.close();
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') void doDecline();
});

subscribe((s: UiState) => {
  if (s.phase !== 'consent_pending') {
    if (built || s.phase === 'idle' || s.phase === 'ended' || s.phase === 'active') window.close();
    return;
  }
  if (!built && s.consent) void build(s.consent);
});
