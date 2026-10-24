/**
 * Deep control through `chrome.debugger` (section 5.4 `debugger` mode). Binding: only the three CDP methods of
 * `CDP_ALLOWED_METHODS` may ever be sent, and `sendCommand` below is the only place in apps/extension that calls
 * `chrome.debugger.sendCommand` (ESLint rule). Any other method throws `cdp_method_not_allowed` before Chrome is
 * called. The debugger permission is optional, requested on a user gesture, and removed at session end.
 */
import { ext } from '../shared/api';

export const CDP_ALLOWED_METHODS = ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText'] as const;
export type CdpMethod = (typeof CDP_ALLOWED_METHODS)[number];
const CDP_VERSION = '1.3';

export async function sendCommand(tabId: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!(CDP_ALLOWED_METHODS as readonly string[]).includes(method)) throw new Error('cdp_method_not_allowed');
  return ext().debugger.sendCommand({ tabId }, method, params);
}

export type DetachCause = 'request' | 'level' | 'navigation' | 'pause' | 'user' | 'close';

export class DebuggerControl {
  readonly attached = new Set<number>();

  constructor(private readonly onChange: (tabId: number, attached: boolean, cause: DetachCause) => void) {}

  /** Worker restart: the attachments Chrome kept (from `ia.session`), re-adopted without a `ctl.event`. */
  restore(tabIds: readonly number[]): void {
    for (const id of tabIds) this.attached.add(id);
  }

  async hasPermission(): Promise<boolean> {
    try {
      return await ext().permissions.contains({ permissions: ['debugger'] });
    } catch {
      return false;
    }
  }

  /** Attaches to one tab (after the caller checked the level); false when the permission or attach fails. */
  async attach(tabId: number): Promise<boolean> {
    if (this.attached.has(tabId)) return true;
    if (!(await this.hasPermission())) return false;
    try {
      await ext().debugger.attach({ tabId }, CDP_VERSION);
    } catch {
      return false;
    }
    this.attached.add(tabId);
    this.onChange(tabId, true, 'request');
    return true;
  }

  async detach(tabId: number, cause: DetachCause): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    try {
      await ext().debugger.detach({ tabId });
    } catch {
      /* already detached */
    }
    this.onChange(tabId, false, cause);
  }

  async detachAll(cause: DetachCause): Promise<void> {
    for (const tabId of [...this.attached]) await this.detach(tabId, cause);
  }

  /** `chrome.debugger.onDetach` (the user cancelled the infobar, or the tab closed). */
  handleDetached(tabId: number | undefined, reason: string): void {
    if (tabId === undefined || !this.attached.delete(tabId)) return;
    this.onChange(tabId, false, reason === 'target_closed' ? 'close' : 'user');
  }

  /** Session end: every session re-prompts at the browser level (section 3.2 permission lifetime). */
  async removePermission(): Promise<void> {
    try {
      await ext().permissions.remove({ permissions: ['debugger'] });
    } catch {
      /* not granted */
    }
  }

  async mouse(tabId: number, params: Record<string, unknown>): Promise<void> {
    await sendCommand(tabId, 'Input.dispatchMouseEvent', params);
  }

  async key(tabId: number, params: Record<string, unknown>): Promise<void> {
    await sendCommand(tabId, 'Input.dispatchKeyEvent', params);
  }

  async insertText(tabId: number, text: string): Promise<void> {
    await sendCommand(tabId, 'Input.insertText', { text });
  }
}

/** CDP modifier bit field: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(m: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }): number {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/** The CDP mouse events for one `input.pointer` op at resolved CSS px coordinates. */
export function cdpMouseEvents(
  kind: 'move' | 'down' | 'up' | 'click' | 'dblclick' | 'contextmenu' | 'wheel',
  x: number,
  y: number,
  button: 0 | 1 | 2,
  modifiers: number,
  deltaX = 0,
  deltaY = 0,
): Record<string, unknown>[] {
  const b = BUTTONS[button];
  const base = { x, y, modifiers };
  const press = (clickCount: number, btn: string = b) => [
    { ...base, type: 'mousePressed', button: btn, clickCount },
    { ...base, type: 'mouseReleased', button: btn, clickCount },
  ];
  switch (kind) {
    case 'move':
      return [{ ...base, type: 'mouseMoved', button: 'none' }];
    case 'down':
      return [{ ...base, type: 'mousePressed', button: b, clickCount: 1 }];
    case 'up':
      return [{ ...base, type: 'mouseReleased', button: b, clickCount: 1 }];
    case 'click':
      return press(1);
    case 'dblclick':
      return [...press(1), ...press(2)];
    case 'contextmenu':
      return press(1, 'right');
    case 'wheel':
      return [{ ...base, type: 'mouseWheel', button: 'none', deltaX, deltaY }];
  }
}
