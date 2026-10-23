/**
 * The join bridge (section 2.2 carrier B, `bridge.js`), the only static content script, injected only on the
 * compiled region origins. It announces the extension (`ia.ext.present`, re-sent on `visibilitychange`) and
 * forwards `ia.join` / `ia.ext.ping` posted by the page itself (`event.source === window`, origin in the compiled
 * list) to the worker, which reads the origin from the browser. Replies go back to `event.origin` only.
 */
import { EXTENSION_VERSION, isRegionOrigin } from '../shared/constants';

export function bridgeAccepts(ev: { source: unknown; origin: string; data: unknown }, win: Window): boolean {
  if (ev.source !== win || !isRegionOrigin(ev.origin)) return false;
  const t = (ev.data as { t?: unknown } | null)?.t;
  return t === 'ia.join' || t === 'ia.ext.ping';
}

export function startBridge(win: Window, rt: { id: string; sendMessage: (m: unknown) => Promise<unknown> }): void {
  const present = () => win.postMessage({ source: 'ia-ext', t: 'ia.ext.present', version: EXTENSION_VERSION, id: rt.id }, win.location.origin);
  win.addEventListener('message', (ev: MessageEvent) => {
    if (!bridgeAccepts(ev, win)) return;
    const origin = ev.origin;
    const isPing = (ev.data as { t?: unknown }).t === 'ia.ext.ping';
    void rt
      .sendMessage({ to: 'worker', t: 'bridge.forward', msg: ev.data })
      .then((reply) => {
        if (!reply || typeof reply !== 'object') return;
        if (isPing) win.postMessage(reply, origin);
        else win.postMessage({ source: 'ia-ext', t: 'ia.join.reply', ...(reply as object) }, origin);
      })
      .catch(() => undefined);
  });
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') present();
  });
  present();
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id && isRegionOrigin(window.location.origin)) startBridge(window, chrome.runtime);
