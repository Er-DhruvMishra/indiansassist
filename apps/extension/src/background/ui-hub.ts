/**
 * The worker side of the `ia.ui` Port (section 9.3): every UI page (side panel, popup, consent, options) connects
 * and receives the full `UiState` on connect and on every change, plus `chat` / `prompt` / `error` pushes.
 */
import { UI_PORT } from '../shared/constants';
import { INITIAL_UI_STATE, type UiState } from '../shared/ui-state';
import { ext } from '../shared/api';

export class UiHub {
  private ports = new Set<chrome.runtime.Port>();
  private state: UiState = { ...INITIAL_UI_STATE };
  private scheduled = false;

  get current(): UiState {
    return this.state;
  }

  get portCount(): number {
    return this.ports.size;
  }

  /** Windows that have a connected side panel (fallback for `runtime.getContexts`). */
  panelWindows(): number[] {
    const out: number[] = [];
    for (const p of this.ports) {
      const w = (p.sender as { windowId?: number } | undefined)?.windowId ?? p.sender?.tab?.windowId;
      if (typeof w === 'number' && p.name === UI_PORT) out.push(w);
    }
    return out;
  }

  attach(port: chrome.runtime.Port): void {
    if (port.name !== UI_PORT || port.sender?.id !== ext().runtime.id) return;
    this.ports.add(port);
    port.onDisconnect.addListener(() => this.ports.delete(port));
    this.post(port, { t: 'state', state: this.state });
  }

  /** Merges a patch into the state and pushes it (coalesced to one push per microtask). */
  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch };
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.broadcast({ t: 'state', state: this.state });
    });
  }

  reset(): void {
    this.set({ ...INITIAL_UI_STATE });
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const p of this.ports) this.post(p, msg);
  }

  private post(port: chrome.runtime.Port, msg: Record<string, unknown>): void {
    try {
      port.postMessage(msg);
    } catch {
      this.ports.delete(port);
    }
  }
}
