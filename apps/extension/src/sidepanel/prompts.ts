/**
 * Prompt cards (sections 3.2, 5.3, 8.4): level and attach requests (Allow / Refuse), unmask requests
 * (Show for 60 s / Refuse), always with the technician's reason as text. A deep-control Allow first runs
 * `chrome.permissions.request` in the click handler; a refusal answers the request `refused`.
 */
import { clear, el } from '../shared/dom';
import type { UiPrompt } from '../shared/ui-state';
import { command, requestDebugger } from '../ui/client';

function title(p: UiPrompt): string {
  if (p.promptKind === 'level') return `${p.technician} asks for: ${(p.label ?? '').toLowerCase()}`;
  if (p.promptKind === 'attach') return `${p.technician} asks to also see the tab ${p.label ?? ''}${p.host ? ` (${p.host})` : ''}`;
  return `${p.technician} asks to see: ${p.label ?? 'a field'}${p.host ? ` on ${p.host}` : ''} for up to 60 seconds`;
}

export function renderPrompts(root: HTMLElement, prompts: UiPrompt[]): void {
  clear(root);
  for (const p of prompts) {
    const card = el('section', null, { class: 'card prompt', role: 'alertdialog', 'aria-label': 'Request from your technician' });
    card.appendChild(el('p', title(p)));
    if (p.reason) card.appendChild(el('p', `Reason: ${p.reason}`, { class: 'muted' }));
    if (p.promptKind === 'level' && p.level === 'deep_control')
      card.appendChild(el('p', 'Chrome will show a debugging bar and ask you to allow it.', { class: 'muted' }));
    if (p.promptKind === 'mask' && p.recording)
      card.appendChild(
        el('p', p.recordRevealed ? 'This session is being recorded; the revealed value will be in the recording.' : 'This session is being recorded; the recording will skip the revealed value.', { class: 'muted' }),
      );
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    card.appendChild(el('p', `Answer within ${left} s`, { class: 'muted' }));
    const row = el('div', null, { class: 'row' });
    const allow = el('button', p.promptKind === 'mask' ? 'Show for 60 s' : p.promptKind === 'attach' ? 'Share it' : 'Allow', { type: 'button', class: 'primary' });
    allow.addEventListener('click', async () => {
      if (p.promptKind === 'level' && p.level === 'deep_control') {
        const granted = await requestDebugger();
        await command({ t: 'ui.prompt', id: p.id, decision: granted ? 'allow' : 'permission_refused' });
        return;
      }
      await command({ t: 'ui.prompt', id: p.id, decision: 'allow' });
    });
    const refuse = el('button', 'Refuse', { type: 'button' });
    refuse.addEventListener('click', () => void command({ t: 'ui.prompt', id: p.id, decision: 'refuse' }));
    row.append(allow, refuse);
    card.appendChild(row);
    root.appendChild(card);
  }
}
