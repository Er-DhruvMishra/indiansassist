/**
 * Side panel voice (section 7 "Voice", binding permission flow): muted by default; the first Unmute runs
 * `getUserMedia` here in the click handler (an offscreen document cannot prompt), stops the track at once and only
 * then tells the worker; a block shows the settings address as text with Copy address.
 */
import { ext } from '../shared/api';
import { button, clear, el } from '../shared/dom';
import { command } from '../ui/client';

export async function micAvailable(): Promise<boolean> {
  try {
    const st = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    st.onchange = () => void command({ t: 'ui.voiceAvailable', available: st.state !== 'denied' });
    return st.state !== 'denied';
  } catch {
    return true;
  }
}

export function renderVoice(root: HTMLElement, voice: { muted: boolean; available: boolean }): void {
  clear(root);
  root.appendChild(el('h2', 'Voice'));
  const row = el('div', null, { class: 'row' });
  if (!voice.available) {
    const addr = `chrome://settings/content/siteDetails?site=chrome-extension://${ext().runtime.id}`;
    root.appendChild(el('p', `Microphone blocked for IndiansAssist; allow it in ${addr}`, { class: 'error' }));
    row.appendChild(button('Copy address', () => void navigator.clipboard.writeText(addr).catch(() => undefined)));
    root.appendChild(row);
    return;
  }
  row.appendChild(
    button(voice.muted ? 'Unmute' : 'Mute', async () => {
      if (voice.muted) {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true });
          for (const t of s.getTracks()) t.stop();
        } catch {
          await command({ t: 'ui.voiceAvailable', available: false });
          return;
        }
      }
      await command({ t: 'ui.voice', muted: !voice.muted });
    }),
  );
  row.appendChild(el('span', voice.muted ? 'Your microphone is off' : 'Your technician can hear you', { class: 'muted' }));
  root.appendChild(row);
}
