/**
 * Section 5.2: the transparent overlay over a monitor's video (`tabindex=0`). Pointer events become `os.pointer`
 * relative to the overlay rect, `wheel` becomes `os.scroll`, keys route to `os.key` or the buffered `os.text`
 * (`beforeinput` data, so IME and dead keys give composed text); copy / cut / paste drive `clipboard.set`.
 * `preventDefault` on everything except F11; holding Escape for 1 s releases the overlay. On blur every modifier is
 * released on the Desk.
 * Phase F section 7.2: `touch-action: none`; touch pointers are recognised as gestures by the view, not here.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { routeKey, wheelNotches, type KeyLike } from './agentInput';

export type OverlayActions = {
  pointer: (monitorId: number, kind: 'move' | 'down' | 'up' | 'click' | 'dblclick', nx: number, ny: number, button: number, mods: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }) => void;
  scroll: (monitorId: number, nx: number, ny: number, dx: number, dy: number) => void;
  key: (kind: 'down' | 'up', e: KeyLike) => void;
  text: (t: string) => void;
  clipboard: (t: string) => void;
  release: () => void;
};

const BUTTON = (b: number) => (b === 1 ? 1 : b === 2 ? 2 : b === 3 ? 3 : b === 4 ? 4 : 0);

export function InputOverlay({ monitorId, enabled, actions, label }: { monitorId: number; enabled: boolean; actions: OverlayActions; label: string }) {
  const escAt = useRef<number | null>(null);
  const el = useRef<HTMLDivElement>(null);
  if (!enabled) return null;
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = el.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { nx: 0, ny: 0 };
    return { nx: (e.clientX - r.left) / r.width, ny: (e.clientY - r.top) / r.height };
  };
  const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
  const onPointer = (kind: 'move' | 'down' | 'up') => (e: PointerEvent<HTMLDivElement>) => {
    // Phase F section 7.2: touch is the gesture layer's (`useTouchSurface` in RemoteView); mouse and pen are unchanged.
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    if (kind === 'down') el.current?.focus();
    const p = pos(e);
    actions.pointer(monitorId, kind, p.nx, p.ny, BUTTON(e.button), mods(e));
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const p = pos(e);
    actions.scroll(monitorId, p.nx, p.ny, wheelNotches(e.deltaX, e.deltaMode), wheelNotches(e.deltaY, e.deltaMode));
  };
  const onKey = (kind: 'down' | 'up') => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'F11') return;
    if (e.key === 'Escape') {
      if (kind === 'down' && escAt.current === null) escAt.current = Date.now();
      if (kind === 'up') {
        const held = escAt.current !== null && Date.now() - escAt.current >= 1000;
        escAt.current = null;
        if (held) {
          actions.release();
          el.current?.blur();
          return;
        }
      }
    }
    const k: KeyLike = { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
    if (routeKey(k) === 'key' || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      e.preventDefault();
      actions.key(kind, k);
    } else if (kind === 'down') {
      e.preventDefault();
      actions.text(e.key);
    }
  };
  return (
    <div
      ref={el}
      tabIndex={0}
      role="application"
      aria-label={label}
      className="absolute inset-0 cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
      onPointerMove={onPointer('move')}
      onPointerDown={onPointer('down')}
      onPointerUp={onPointer('up')}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={onWheel}
      onKeyDown={onKey('down')}
      onKeyUp={onKey('up')}
      onCopy={(e) => {
        e.preventDefault();
      }}
      onPaste={(e) => {
        e.preventDefault();
        const t = e.clipboardData?.getData('text/plain') ?? '';
        if (t) actions.clipboard(t);
      }}
      onBlur={() => actions.release()}
    />
  );
}
