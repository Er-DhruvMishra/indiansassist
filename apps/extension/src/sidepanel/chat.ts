/** Side panel chat (Phase A 8.1 protocol; every message rendered with `textContent`). */
import { clear, el } from '../shared/dom';
import type { ChatLine } from '../shared/ui-state';
import { command } from '../ui/client';

export function buildChat(root: HTMLElement): (lines: ChatLine[]) => void {
  root.appendChild(el('h2', 'Chat'));
  const log = el('div', null, { class: 'chat', role: 'log', 'aria-live': 'polite' });
  const input = el('input', null, { type: 'text', 'aria-label': 'Message to your technician', maxlength: 4000 });
  const send = el('button', 'Send', { type: 'button' });
  const go = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await command({ t: 'ui.chat', text });
  };
  send.addEventListener('click', () => void go());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void go();
  });
  const row = el('div', null, { class: 'row' });
  input.classList.add('grow');
  row.append(input, send);
  root.append(log, row);
  let shown = 0;
  return (lines) => {
    if (lines.length === shown) return;
    clear(log);
    for (const l of lines) log.appendChild(el('div', l.text, { class: l.from === 'desk' ? 'me' : '' }));
    shown = lines.length;
    log.scrollTop = log.scrollHeight;
  };
}
