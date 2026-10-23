/**
 * Side panel idle view (section 2.3): Paste from clipboard (the panel reads the clipboard in the click handler,
 * never without the click), a manual "Support code or link" field, the optional "Your name", Connect.
 */
import { LOCAL_KEYS, readLocal } from '../shared/storage';
import { parseJoinInput } from '../shared/join-input';
import { button, el } from '../shared/dom';
import { command } from '../ui/client';

export function buildConnect(root: HTMLElement): { setError: (msg: string | null) => void } {
  const card = el('section', null, { class: 'card', 'aria-labelledby': 'connect-h' });
  card.appendChild(el('h2', 'Connect to your technician', { id: 'connect-h' }));
  card.appendChild(el('p', 'Your technician gave you a code or a link. Paste it here; nothing is shared until you choose what to share.', { class: 'muted' }));
  const error = el('p', null, { class: 'error', role: 'alert' });
  const name = el('input', null, { type: 'text', id: 'desk-name', maxlength: 80, autocomplete: 'name' });
  void readLocal<string>(LOCAL_KEYS.lastDeskLabel).then((v) => {
    if (v && !name.value) name.value = v;
  });
  const code = el('input', null, { type: 'text', id: 'code', autocomplete: 'off', spellcheck: 'false' });
  const deskLabel = () => (name.value.trim() ? { deskLabel: name.value.trim().slice(0, 80) } : {});

  const paste = button('Paste from clipboard', async () => {
    error.textContent = '';
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      error.textContent = 'The clipboard could not be read. Paste the code into the field instead.';
      return;
    }
    const parsed = parseJoinInput(text);
    if (!parsed) {
      error.textContent = 'No IndiansAssist code on the clipboard';
      return;
    }
    await command({ t: 'ui.connect', code: parsed.value, via: 'clipboard', ...deskLabel() });
  }, { class: 'primary' });

  const connect = button('Connect', async () => {
    error.textContent = '';
    const parsed = parseJoinInput(code.value);
    if (!parsed) {
      error.textContent = 'Enter the 12-digit code, the token or the full link.';
      return;
    }
    await command({ t: 'ui.connect', code: parsed.value, via: 'manual', ...deskLabel() });
  });

  const nameLabel = el('label', null, { class: 'block', for: 'desk-name' });
  nameLabel.appendChild(el('span', 'Your name (optional)'));
  nameLabel.appendChild(name);
  const codeLabel = el('label', null, { class: 'block', for: 'code' });
  codeLabel.appendChild(el('span', 'Support code or link'));
  codeLabel.appendChild(code);
  code.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') connect.click();
  });
  card.append(paste, nameLabel, codeLabel, connect, error);
  root.appendChild(card);
  return {
    setError: (msg) => {
      error.textContent = msg ?? '';
    },
  };
}
