/**
 * Side panel (section 7, vanilla TS by binding decision): token entry when idle, waiting status, the live session
 * (header with Stop sharing always visible, level / background-tab controls, tabs, prompts, chat, voice, files,
 * session info) and the receipt after the end.
 */
import '../ui/styles.css';
import { CONSENT_LEVELS, CONSENT_LEVEL_ORDER, type ConsentLevel } from '@indiansassist/shared';
import { ext } from '../shared/api';
import { append, button, clear, el } from '../shared/dom';
import { LEVEL_LABELS, type Receipt, type UiState } from '../shared/ui-state';
import { command, formatDuration, requestDebugger, subscribe } from '../ui/client';
import { buildChat } from './chat';
import { buildConnect } from './connect';
import { buildFiles } from './files';
import { renderPrompts } from './prompts';
import { renderTabs } from './tabs';
import { micAvailable, renderVoice } from './voice';

const main = document.getElementById('app')!;
const header = el('header', null, { class: 'card' });
const status = el('p', null, { class: 'muted', role: 'status' });
const errorLine = el('p', null, { class: 'error', role: 'alert' });
const connectRoot = el('div');
const waitingRoot = el('section', null, { class: 'card' });
const prompts = el('div');
const tabsRoot = el('section', null, { class: 'card' });
const controls = el('section', null, { class: 'card' });
const chatRoot = el('section', null, { class: 'card' });
const voiceRoot = el('section', null, { class: 'card' });
const filesRoot = el('section', null, { class: 'card' });
const infoRoot = el('section', null, { class: 'card' });
const receiptRoot = el('section', null, { class: 'card' });
append(main, header, status, errorLine, connectRoot, waitingRoot, prompts, tabsRoot, controls, chatRoot, voiceRoot, filesRoot, infoRoot, receiptRoot);

const connect = buildConnect(connectRoot);
const renderChat = buildChat(chatRoot);
const renderFiles = buildFiles(filesRoot);
let state: UiState | null = null;
let closeBackstage = true;
void micAvailable().then((available) => command({ t: 'ui.voiceAvailable', available }));

const WAITING_TEXT: Partial<Record<UiState['phase'], string>> = {
  have_token: 'Checking the code...',
  connecting: 'Connecting...',
  waiting: 'Waiting for your technician',
  held: 'Your technician is not online yet; the extension keeps trying.',
  knocked: 'Your technician is being asked to accept.',
  consent_pending: 'A window asks you what to share.',
};

function show(node: HTMLElement, on: boolean): void {
  node.classList.toggle('hidden', !on);
}

function renderHeader(s: UiState): void {
  clear(header);
  const row = el('div', null, { class: 'row' });
  const title = el('div', null, { class: 'grow' });
  title.appendChild(el('h1', s.session ? `Sharing with ${s.session.assist}` : 'IndiansAssist'));
  if (s.token?.org) title.appendChild(el('p', s.token.org, { class: 'muted' }));
  row.appendChild(title);
  if (s.session?.startedAt) row.appendChild(el('span', formatDuration(Date.now() - s.session.startedAt), { class: 'chip' }));
  header.appendChild(row);
  if (s.phase === 'active' && s.session) {
    const chips = el('div', null, { class: 'row' });
    chips.appendChild(el('span', LEVEL_LABELS[s.session.level], { class: 'chip on' }));
    chips.appendChild(el('span', s.session.scope === 'all_tabs' ? 'All tabs' : 'This tab only', { class: 'chip' }));
    chips.appendChild(el('span', s.session.backstage ? 'Background tabs: on' : 'Background tabs: off', { class: 'chip' }));
    chips.appendChild(el('span', s.session.transport === 'relay' ? 'relayed (via server)' : 'direct', { class: s.session.transport === 'relay' ? 'chip warn' : 'chip' }));
    if (s.session.recording) chips.appendChild(el('span', 'Recording', { class: 'chip danger' }));
    if (s.session.debuggerTabs.length > 0) chips.appendChild(el('span', 'DEEP CONTROL', { class: 'chip danger' }));
    header.appendChild(chips);
    const keep = el('input', null, { type: 'checkbox', id: 'close-bg', checked: closeBackstage });
    keep.addEventListener('change', () => (closeBackstage = keep.checked));
    const stop = button(s.session.finishing ? 'Finishing...' : 'Stop sharing', () => void command({ t: 'ui.stop', closeBackstage }), { class: 'danger', disabled: s.session.finishing });
    header.appendChild(stop);
    if (s.session.backstageCount > 0) {
      const l = el('label', null, { for: 'close-bg' });
      l.append(keep, el('span', "Close technician's background tabs"));
      header.appendChild(l);
    }
  } else if (s.phase !== 'idle' && s.phase !== 'ended') {
    header.appendChild(button('Cancel', () => void command({ t: 'ui.cancel' })));
  }
}

function renderControls(s: UiState): void {
  clear(controls);
  const sess = s.session;
  if (!sess) return;
  controls.appendChild(el('h2', 'What your technician can do'));
  const select = el('select', null, { 'aria-label': 'Change what they can do' });
  for (const lv of CONSENT_LEVELS) {
    if (CONSENT_LEVEL_ORDER[lv] > CONSENT_LEVEL_ORDER[sess.maxLevel]) continue;
    const o = el('option', LEVEL_LABELS[lv], { value: lv });
    o.selected = lv === sess.level;
    select.appendChild(o);
  }
  select.addEventListener('change', async () => {
    const level = select.value as ConsentLevel;
    if (level === 'deep_control' && !(await requestDebugger())) {
      select.value = sess.level;
      errorLine.textContent = 'Deep control needs Chrome permission; nothing changed.';
      return;
    }
    await command({ t: 'ui.level', level });
  });
  controls.appendChild(select);
  if (sess.backstageAllowed) {
    const cb = el('input', null, { type: 'checkbox', id: 'bg-allow', checked: sess.backstage });
    cb.addEventListener('change', () => void command({ t: 'ui.backstage', allowed: cb.checked }));
    const l = el('label', null, { for: 'bg-allow' });
    l.append(cb, el('span', 'Allow the technician to open background tabs'));
    controls.appendChild(l);
  }
  const row = el('div', null, { class: 'row' });
  row.appendChild(button('Revoke consent', () => void command({ t: 'ui.revoke' })));
  row.appendChild(button('Open options', () => void ext().runtime.openOptionsPage()));
  controls.appendChild(row);
}

function renderInfo(s: UiState): void {
  clear(infoRoot);
  const sess = s.session;
  if (!sess) return;
  infoRoot.appendChild(el('h2', 'Session info'));
  infoRoot.appendChild(el('p', `Session ${sess.sessionId}`, { class: 'muted' }));
  if (sess.startedAt) infoRoot.appendChild(el('p', `Started ${new Date(sess.startedAt).toLocaleTimeString()}`, { class: 'muted' }));
  infoRoot.appendChild(el('p', `What is shared: ${sess.tabs.filter((t) => t.mirrored === 'yes').length} tab(s), ${sess.scope === 'all_tabs' ? 'all your tabs' : 'only the tabs you chose'}. Passwords and fields marked sensitive stay hidden.`));
  if (sess.transport === 'relay') infoRoot.appendChild(el('p', 'Relayed through the server (degraded, not end-to-end encrypted).', { class: 'error' }));
}

function renderReceipt(r: Receipt | null): void {
  clear(receiptRoot);
  if (!r) return;
  receiptRoot.appendChild(el('h2', 'Session ended'));
  receiptRoot.appendChild(el('p', `${r.technician} - ${r.org}`));
  receiptRoot.appendChild(el('p', `Ended: ${r.endReason}${r.durationMs !== null ? `, lasted ${formatDuration(r.durationMs)}` : ''}`, { class: 'muted' }));
  const hosts = [...new Set(r.tabsShared.map((t) => t.host))];
  receiptRoot.appendChild(el('p', `Sites shared: ${hosts.length > 0 ? hosts.join(', ') : 'none'}`));
  receiptRoot.appendChild(el('p', `Level changes: ${r.levelChanges.length}; fields revealed: ${r.unmasks.length}; background tabs: ${r.backstage.length}; tab actions: ${r.tabActions}; inputs: ${r.inputs}${r.relayed ? '; relayed through the server' : ''}${r.recordingSeen ? '; recorded' : ''}`, { class: 'muted' }));
  const row = el('div', null, { class: 'row' });
  row.appendChild(
    button('Download receipt (JSON)', () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `indiansassist-receipt-${r.sessionId}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }),
  );
  row.appendChild(button('Done', () => void command({ t: 'ui.dismissEnded' }), { class: 'primary' }));
  receiptRoot.appendChild(row);
}

function render(s: UiState): void {
  state = s;
  const live = s.phase === 'active' && s.session !== null;
  renderHeader(s);
  status.textContent = s.status ?? '';
  errorLine.textContent = s.lastError?.message ?? '';
  connect.setError(null);
  show(connectRoot, s.phase === 'idle');
  show(waitingRoot, WAITING_TEXT[s.phase] !== undefined);
  clear(waitingRoot);
  if (WAITING_TEXT[s.phase]) waitingRoot.appendChild(el('p', s.phase === 'waiting' && s.token?.technician ? `Waiting for ${s.token.technician}` : WAITING_TEXT[s.phase]!));
  renderPrompts(prompts, s.prompts);
  for (const n of [tabsRoot, controls, chatRoot, voiceRoot, filesRoot, infoRoot]) show(n, live);
  if (live) {
    renderTabs(tabsRoot, s.session!);
    renderControls(s);
    renderVoice(voiceRoot, s.voice);
    renderInfo(s);
  }
  renderChat(s.chat);
  renderFiles(s.files);
  show(receiptRoot, s.phase === 'ended');
  renderReceipt(s.phase === 'ended' ? s.receipt : null);
}

subscribe(render);
// The timer and the prompt countdowns tick without rebuilding the controls.
setInterval(() => {
  if (!state) return;
  if (state.phase === 'active') renderHeader(state);
  if (state.prompts.length > 0) renderPrompts(prompts, state.prompts);
}, 1000);
