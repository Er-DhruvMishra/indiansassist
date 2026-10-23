/**
 * The join popup window (section 9.6): opened by the worker after a join handshake when no side panel is open.
 * Shows the org and technician from the lookup, the status, Cancel, and a link to the side panel. It closes itself
 * once the consent window opens.
 */
import '../ui/styles.css';
import { ext } from '../shared/api';
import { append, button, clear, el } from '../shared/dom';
import type { UiState } from '../shared/ui-state';
import { command, subscribe } from '../ui/client';

const TEXT: Partial<Record<UiState['phase'], string>> = {
  have_token: 'Checking the code...',
  connecting: 'Connecting...',
  waiting: 'Waiting for your technician to accept.',
  held: 'Your technician is not online yet; the extension keeps trying.',
  knocked: 'Your technician is being asked to accept.',
};

const main = document.getElementById('app')!;
const card = el('section', null, { class: 'card' });
append(main, card);

function render(s: UiState): void {
  if (s.phase === 'consent_pending' || s.phase === 'active') return window.close();
  clear(card);
  card.appendChild(el('h1', 'IndiansAssist'));
  if (s.token) {
    card.appendChild(el('p', s.token.org));
    card.appendChild(el('p', `Technician: ${s.token.technician ?? 'your technician'}`, { class: 'muted' }));
  }
  card.appendChild(el('p', s.lastError?.message ?? TEXT[s.phase] ?? (s.phase === 'idle' ? 'No session.' : ''), { role: 'status', class: s.lastError ? 'error' : '' }));
  const row = el('div', null, { class: 'row' });
  if (s.phase !== 'idle' && s.phase !== 'ended') row.appendChild(button('Cancel', () => void command({ t: 'ui.cancel' }).then(() => window.close())));
  row.appendChild(
    button('Open the side panel instead', async () => {
      const win = await ext().windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      if (win?.id !== undefined) await ext().sidePanel.open({ windowId: win.id }).catch(() => undefined);
      window.close();
    }),
  );
  card.appendChild(row);
}

subscribe(render);
