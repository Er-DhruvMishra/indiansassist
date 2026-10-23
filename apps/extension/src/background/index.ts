/**
 * Service worker entry (section 9.2). Every listener is registered synchronously at the top level (MV3), and
 * every handler waits for the state restore from `chrome.storage.session` so a worker restart resumes the
 * session (section 3.5). Message routing checks who sent what: UI commands only from extension pages, `cs.*`
 * only from top-frame content scripts, offscreen messages only from the offscreen document, handshakes by origin.
 */
import { ext } from '../shared/api';
import { onBus } from '../shared/bus';
import { EXTENSION_VERSION, KEEPALIVE_ALARM, OFFSCREEN_PATH, UI_PORT } from '../shared/constants';
import { lockSessionStorage, patchDiagnostics, readLocal, LOCAL_KEYS, type Diagnostics } from '../shared/storage';
import { handleContentMessage, handleUiCommand } from './commands';
import { handleHandshake, senderOrigin } from './external';
import { LiveSession } from './live-session';
import { handleOffscreenMessage } from './offscreen-messages';
import { decline } from './session-end';
import { SessionMachine } from './session-machine';

const api = ext();
const machine = new SessionMachine({ extensionId: api.runtime.id });
machine.liveFactory = (m) => new LiveSession(m);

const ready: Promise<void> = (async () => {
  await lockSessionStorage();
  try {
    await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* side panel unsupported */
  }
  await machine.restore().catch((e: unknown) => console.error('[worker] restore failed', e));
})();

async function onOriginRefused(origin: string | null): Promise<void> {
  const d = await readLocal<Diagnostics>(LOCAL_KEYS.diagnostics);
  await patchDiagnostics({ originRefusals: (d?.originRefusals ?? 0) + 1, lastError: `join refused from ${origin ?? 'unknown origin'}` }, EXTENSION_VERSION);
}

const handshakeDeps = {
  extensionId: api.runtime.id,
  join: async (code: string, origin: string) => machine.join(code, origin),
  onOriginRefused: (origin: string | null) => void onOriginRefused(origin),
};

/** Extension pages (side panel, popup and consent windows, options); the consent and popup windows are tabs too. */
function fromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === api.runtime.id && (sender.url ?? '').startsWith(`chrome-extension://${api.runtime.id}/`);
}

api.runtime.onInstalled.addListener(() => {
  void api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void api.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => undefined);
});

onBus('worker', (msg, sender) => {
  if (sender.id !== api.runtime.id) return undefined;
  const t = msg.t;
  if (t === 'bridge.forward') {
    // Carrier B: the bridge runs on the region origins only; the origin comes from the browser, not the page.
    if (!sender.tab || sender.frameId !== 0) return undefined;
    return ready.then(() => handleHandshake(msg.msg, senderOrigin(sender), handshakeDeps));
  }
  if (t.startsWith('ui.')) return fromExtensionPage(sender) ? ready.then(() => handleUiCommand(machine, msg)) : undefined;
  if (t.startsWith('cs.')) {
    if (!sender.tab || sender.frameId !== 0 || (sender.url ?? '').startsWith('chrome-extension://')) return undefined;
    return ready.then(() => handleContentMessage(machine, msg, sender.tab?.id));
  }
  if (sender.url === api.runtime.getURL(OFFSCREEN_PATH)) return ready.then(() => handleOffscreenMessage(machine, msg));
  return undefined;
});

// Carrier A (externally_connectable): `sender.origin` is re-checked against the compiled list.
api.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  void ready
    .then(() => handleHandshake(msg, senderOrigin(sender), handshakeDeps))
    .then((reply) => sendResponse(reply))
    .catch(() => sendResponse({ ok: false, error: 'version' }));
  return true;
});

api.runtime.onConnect.addListener((port) => {
  if (port.name === UI_PORT) void ready.then(() => machine.ui.attach(port));
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void ready.then(() => machine.isLive || api.alarms.clear(KEEPALIVE_ALARM));
});

api.tabs.onCreated.addListener((tab) => void ready.then(() => machine.live?.tabs.onCreated(tab)));
api.tabs.onUpdated.addListener((tabId, change, tab) => void ready.then(() => machine.live?.tabs.onUpdated(tabId, change, tab)));
api.tabs.onRemoved.addListener((tabId) => void ready.then(() => machine.live?.tabs.onRemoved(tabId)));
api.tabs.onActivated.addListener(() => void ready.then(() => machine.live?.tabs.scheduleTabsPush()));
api.windows.onRemoved.addListener((windowId) =>
  void ready.then(() => {
    // The consent window closing without an answer is a Decline (section 3.1).
    if (windowId === machine.consentWindowId) {
      machine.consentWindowId = null;
      if (machine.phase === 'consent_pending' && !machine.s?.consent) decline(machine);
    }
    if (windowId === machine.popupWindowId) machine.popupWindowId = null;
  }),
);
// `chrome.debugger` exists only while the optional permission is granted (section 3.2).
let debuggerHooked = false;
function hookDebugger(): void {
  const d = (api as { debugger?: typeof chrome.debugger }).debugger;
  if (debuggerHooked || !d?.onDetach) return;
  debuggerHooked = true;
  d.onDetach.addListener((source, reason) => void ready.then(() => machine.live?.debuggerControl.handleDetached(source.tabId, reason)));
}
hookDebugger();
api.permissions.onAdded.addListener(() => hookDebugger());
