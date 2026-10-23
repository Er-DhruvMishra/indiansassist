/**
 * Capture content script entry (`content.js`, IIFE, injected only during an active session, top frame only).
 * Guarded by one isolated-world global so a registered and an executed injection never run two recorders; the
 * guard is released when the script stops so the tab can be attached again later.
 */
import { Capture } from './capture';

type Guarded = typeof globalThis & { __iaCapture?: boolean };
const g = globalThis as Guarded;

if (!g.__iaCapture && window.top === window) {
  g.__iaCapture = true;
  const listener = (msg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void): boolean => {
    if (!msg || typeof msg !== 'object' || (msg as { to?: unknown }).to !== 'content') return false;
    const out = capture.handleWorker(msg);
    if (out !== undefined) sendResponse(out);
    return false;
  };
  const capture = new Capture(document, window, chrome.runtime, () => {
    chrome.runtime.onMessage.removeListener(listener);
    g.__iaCapture = false;
  });
  chrome.runtime.onMessage.addListener(listener);
  capture.announce();
}
