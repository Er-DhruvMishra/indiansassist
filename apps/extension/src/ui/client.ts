/**
 * UI page side of the bus (section 9.3): commands to the worker with `chrome.runtime.sendMessage`, state pushes
 * over the `ia.ui` Port (full `UiState` on connect and on every change), re-connecting if the worker restarts.
 */
import { ext } from '../shared/api';
import { sendBus } from '../shared/bus';
import type { UiCommand } from '../shared/bus-schemas';
import { UI_PORT } from '../shared/constants';
import { INITIAL_UI_STATE, type UiState } from '../shared/ui-state';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Command = DistOmit<UiCommand, 'to'>;

export function command<T = unknown>(c: Command): Promise<T | undefined> {
  return sendBus<T>({ ...c, to: 'worker' } as never);
}

export type Push = { t: string } & Record<string, unknown>;

export function subscribe(onState: (s: UiState) => void, onPush?: (p: Push) => void): () => void {
  let port: chrome.runtime.Port | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    port = ext().runtime.connect({ name: UI_PORT });
    port.onMessage.addListener((m: Push) => {
      if (m.t === 'state') onState({ ...INITIAL_UI_STATE, ...(m.state as Partial<UiState>) });
      else onPush?.(m);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 500);
    });
  };
  connect();
  return () => {
    closed = true;
    port?.disconnect();
  };
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** The side panel or consent window asks for the debugger permission inside the click handler (a user gesture). */
export async function requestDebugger(): Promise<boolean> {
  try {
    return await ext().permissions.request({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}
