/**
 * Message bus between extension contexts (section 9.3). `chrome.runtime.onMessage` fires in every extension
 * context, so every message carries `to`; a listener returns `false` synchronously for a message not addressed to
 * it, so `sendResponse` never races. Request/response pairs exist only worker <-> offscreen and ui -> worker;
 * everything else is a push over a Port. Binary never crosses the bus.
 */
import { ext } from './api';

export const BUS_TARGETS = ['worker', 'offscreen', 'ui', 'content'] as const;
export type BusTarget = (typeof BUS_TARGETS)[number];
export type BusMessage = { to: BusTarget; t: string } & Record<string, unknown>;
export type BusSender = chrome.runtime.MessageSender;
export type BusHandler = (msg: BusMessage, sender: BusSender) => unknown;

/**
 * The raw listener for `target` (exported for tests). Returns `false` synchronously when the message is not for
 * this context; returns `true` only when it will answer asynchronously.
 */
export function busListener(target: BusTarget, handler: BusHandler) {
  return (msg: unknown, sender: BusSender, sendResponse: (r?: unknown) => void): boolean => {
    if (!msg || typeof msg !== 'object' || (msg as { to?: unknown }).to !== target) return false;
    if (typeof (msg as { t?: unknown }).t !== 'string') return false;
    let out: unknown;
    try {
      out = handler(msg as BusMessage, sender);
    } catch (e) {
      sendResponse({ ok: false, error: String(e).slice(0, 200) });
      return false;
    }
    if (out instanceof Promise) {
      out.then(
        (r) => sendResponse(r),
        (e) => sendResponse({ ok: false, error: String(e).slice(0, 200) }),
      );
      return true;
    }
    if (out !== undefined) sendResponse(out);
    return false;
  };
}

/** Registers a bus listener for `target`; returns the remover. */
export function onBus(target: BusTarget, handler: BusHandler): () => void {
  const listener = busListener(target, handler);
  ext().runtime.onMessage.addListener(listener);
  return () => ext().runtime.onMessage.removeListener(listener);
}

/** Sends a message to another extension context (worker, offscreen or ui). */
export async function sendBus<T = unknown>(msg: BusMessage): Promise<T | undefined> {
  try {
    return (await ext().runtime.sendMessage(msg)) as T;
  } catch {
    return undefined; // no receiver (for example the offscreen document is not open)
  }
}

/** Sends a message to the content script of one tab. */
export async function sendToTab<T = unknown>(tabId: number, msg: Omit<BusMessage, 'to'>): Promise<T | undefined> {
  try {
    return (await ext().tabs.sendMessage(tabId, { ...msg, to: 'content' })) as T;
  } catch {
    return undefined;
  }
}
