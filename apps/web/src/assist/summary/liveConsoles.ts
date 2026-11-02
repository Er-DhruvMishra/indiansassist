/**
 * Phase E section 5.3a-b: the live consoles the transcript hook works with. `useEnterpriseLiveHooks` is called with
 * `{ sessionId, tier }` before the console's controller exists, so each live console controller registers itself
 * here (one line in its constructor and `dispose`) and the hook watches for the controller of its session. Only the
 * public controller surface is used: the snapshot (phase, chat, playbook runs), `subscribe` and `sendChat`.
 */

/** One chat line as every console snapshot holds it (`lib/link` ChatItem). */
export type LiveChatItem = { msgId: string; from: 'assist' | 'desk'; text: string; ts: number; mine?: boolean };
/** One playbook run of the P3 console (`agentState` PlaybookRun). */
export type LiveRun = { runId: string; name?: string; stdout: string; stderr: string };

export type LiveConsoleHandle = {
  readonly snapshot: { readonly phase: string; readonly chat: readonly LiveChatItem[]; readonly runs?: readonly LiveRun[] };
  subscribe: (listener: () => void) => () => void;
  sendChat: (text: string) => void;
};

type Watcher = (handle: LiveConsoleHandle | null) => void;

const consoles = new Map<string, LiveConsoleHandle>();
const watchers = new Map<string, Set<Watcher>>();

function notify(sessionId: string): void {
  const h = consoles.get(sessionId) ?? null;
  for (const w of [...(watchers.get(sessionId) ?? [])]) w(h);
}

/** Called by a live console controller when it is created; the returned function unregisters it (dispose). */
export function registerLiveConsole(sessionId: string, handle: LiveConsoleHandle): () => void {
  consoles.set(sessionId, handle);
  notify(sessionId);
  return () => {
    if (consoles.get(sessionId) !== handle) return;
    consoles.delete(sessionId);
    notify(sessionId);
  };
}

/** Calls `cb` with the session's current console (or null) now and on every change; returns the unsubscribe. */
export function watchLiveConsole(sessionId: string, cb: Watcher): () => void {
  let set = watchers.get(sessionId);
  if (!set) {
    set = new Set();
    watchers.set(sessionId, set);
  }
  set.add(cb);
  cb(consoles.get(sessionId) ?? null);
  return () => {
    set.delete(cb);
    if (set.size === 0) watchers.delete(sessionId);
  };
}
