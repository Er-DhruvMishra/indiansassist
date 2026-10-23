/**
 * Side panel files (section 7 "Files"): sending creates a `blob:` URL for the offscreen document; an incoming
 * offer shows the A F6 accept dialog (name via `textContent`, declared type, size, executable warning) and a
 * received file is saved with `<a download>`.
 */
import { button, clear, el } from '../shared/dom';
import { formatBytes } from '../shared/file-transfer';
import type { FileRow } from '../shared/ui-state';
import { command } from '../ui/client';

function save(row: FileRow): void {
  if (!row.blobUrl) return;
  const a = document.createElement('a');
  a.href = row.blobUrl; // a blob: URL created by this extension's offscreen document
  a.download = row.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function buildFiles(root: HTMLElement): (rows: FileRow[]) => void {
  root.appendChild(el('h2', 'Files'));
  const picker = el('input', null, { type: 'file', 'aria-label': 'Send a file to your technician' });
  picker.addEventListener('change', async () => {
    const f = picker.files?.[0];
    if (!f) return;
    const blobUrl = URL.createObjectURL(f);
    await command({ t: 'ui.sendFile', blobUrl, name: f.name, size: f.size, mime: f.type || 'application/octet-stream' });
    picker.value = '';
  });
  const list = el('ul', null, { class: 'list' });
  root.append(picker, list);
  return (rows) => {
    clear(list);
    for (const r of rows) {
      const li = el('li');
      const info = el('div', null, { class: 'grow' });
      info.appendChild(el('div', `${r.outgoing ? 'Sent' : 'From technician'}: ${r.name}`));
      info.appendChild(el('div', `${formatBytes(r.size)} - ${r.mime}${r.sniffed ? ` (looks like ${r.sniffed})` : ''} - ${r.status}${r.error ? `: ${r.error}` : ''}`, { class: 'muted' }));
      if (!r.outgoing && r.executable) info.appendChild(el('div', 'This file can run programs. Only open it if you trust it.', { class: 'error' }));
      li.appendChild(info);
      if (!r.outgoing && r.status === 'offered') {
        li.appendChild(button('Accept', () => void command({ t: 'ui.fileDecision', key: r.key, accept: true }), { class: 'primary' }));
        li.appendChild(button('Decline', () => void command({ t: 'ui.fileDecision', key: r.key, accept: false })));
      }
      if (!r.outgoing && r.status === 'done' && r.blobUrl) li.appendChild(button('Save', () => save(r)));
      list.appendChild(li);
    }
  };
}
