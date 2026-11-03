/**
 * Phase F section 7.2: the touch layer of a remote view. Touch pointers on the view (the `outer` element, the clipping
 * box) run through the shared gesture recognizer; pinch and pans move a local view transform applied to `inner` (the
 * element that is exactly the monitor's video rectangle); taps, presses, drags and two-finger scrolls become ops whose
 * points are normalised to `inner`'s rectangle **after** the transform, so zoom never changes where an op lands.
 *
 * Only `pointerType: 'touch'` is handled, in the capture phase, and stopped there: mouse and pen pointers reach the
 * existing `InputOverlay` and `AnnotationCanvas` exactly as before. Elements marked `data-touch-ignore` (the zoom chip)
 * keep their own touches.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  DEFAULT_GESTURE_CONFIG,
  clampZoom,
  createGestureRecognizer,
  deskUsesDoubleTap,
  mapGestureToOps,
  type GestureDesk,
  type GestureEvent,
  type GestureOutput,
  type GestureRecognizer,
} from '@indiansassist/shared';

export type TouchOp = { op: string; args: Record<string, unknown> };
export type AnnotateAction = { action: 'laser' | 'draw'; phase?: 'start' | 'move' | 'end'; x: number; y: number };

export type TouchSurfaceOptions = {
  outer: RefObject<HTMLElement | null>;
  inner: RefObject<HTMLElement | null>;
  /** Off: no listener is attached (the view behaves exactly as before). */
  enabled: boolean;
  desk: GestureDesk;
  trackpad: boolean;
  scrollWhileZoomed: boolean;
  onOp?: (op: TouchOp) => void;
  onAnnotate?: (a: AnnotateAction) => void;
  onKeyboardToggle?: () => void;
  /** Test injection: the clock (performance.now) and the haptic call (navigator.vibrate). */
  now?: () => number;
  vibrate?: (ms: number) => void;
};

export type TouchSurfaceState = {
  zoom: number;
  /** Style for `inner`: the view transform (identity at zoom 1). */
  innerStyle: CSSProperties;
  /** Style for `outer`: no browser gestures, no callout, no selection. */
  outerStyle: CSSProperties;
  /** The Trackpad cursor, normalised to the video rectangle, or null when Trackpad mode is off. */
  cursor: { x: number; y: number } | null;
  resetZoom: () => void;
};

type View = { zoom: number; tx: number; ty: number };
const IDENTITY: View = { zoom: 1, tx: 0, ty: 0 };
const TICK_MS = 40;

const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

/** Keeps the zoomed content covering the video rectangle (no empty band inside it). */
export function clampView(v: View, w: number, h: number): View {
  const zoom = clampZoom(v.zoom);
  if (zoom === 1) return IDENTITY;
  const minX = w * (1 - zoom);
  const minY = h * (1 - zoom);
  return { zoom, tx: Math.min(0, Math.max(minX, v.tx)), ty: Math.min(0, Math.max(minY, v.ty)) };
}

/** Zoom by `scale` about `m` (CSS px relative to the untransformed video rectangle). */
export function zoomAbout(v: View, scale: number, m: { x: number; y: number }, w: number, h: number): View {
  const zoom = clampZoom(v.zoom * scale);
  const px = (m.x - v.tx) / v.zoom;
  const py = (m.y - v.ty) / v.zoom;
  return clampView({ zoom, tx: m.x - zoom * px, ty: m.y - zoom * py }, w, h);
}

export function useTouchSurface(o: TouchSurfaceOptions): TouchSurfaceState {
  const [view, setView] = useState<View>(IDENTITY);
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const opts = useRef(o);
  opts.current = o;
  const viewRef = useRef(view);
  viewRef.current = view;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const recognizer = useRef<GestureRecognizer | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const doubleTap = deskUsesDoubleTap(o.desk);

  // A new recognizer when the double-tap rule changes (P1 reports taps at once).
  useEffect(() => {
    recognizer.current = createGestureRecognizer({ ...DEFAULT_GESTURE_CONFIG, doubleTapGapMs: doubleTap ? DEFAULT_GESTURE_CONFIG.doubleTapGapMs : 0 }, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
    return () => recognizer.current?.reset();
  }, [doubleTap]);

  const apply = useCallback((events: GestureEvent[]) => {
    const p = opts.current;
    const outer = p.outer.current;
    const inner = p.inner.current;
    if (!outer || !inner || events.length === 0) return;
    const oRect = outer.getBoundingClientRect();
    const iRect = inner.getBoundingClientRect();
    const w = inner.offsetWidth || iRect.width / viewRef.current.zoom;
    const h = inner.offsetHeight || iRect.height / viewRef.current.zoom;
    const mode = { zoom: viewRef.current.zoom, trackpad: p.trackpad, scrollWhileZoomed: p.scrollWhileZoomed };
    const toNorm = (x: number, y: number) => ({
      x: iRect.width > 0 ? (oRect.left + x - iRect.left) / iRect.width : 0,
      y: iRect.height > 0 ? (oRect.top + y - iRect.top) / iRect.height : 0,
    });
    const trackpad = p.trackpad && (p.desk.kind === 'native' || p.desk.kind === 'android') && p.desk.control;
    for (const g of events) {
      let ev: GestureEvent = g;
      if (g.kind === 'tap' || g.kind === 'double_tap' || g.kind === 'long_press' || g.kind === 'drag') {
        let pt = toNorm(g.x, g.y);
        if (trackpad) {
          if (g.kind === 'drag' && g.phase !== 'start') {
            const c = cursorRef.current;
            const next = { x: r4(c.x + (g.dx ?? 0) / Math.max(1, iRect.width)), y: r4(c.y + (g.dy ?? 0) / Math.max(1, iRect.height)) };
            cursorRef.current = next;
            setCursor(next);
          }
          pt = cursorRef.current;
        }
        ev = { ...g, x: pt.x, y: pt.y };
      } else if (g.kind === 'two_finger_drag') {
        const pt = toNorm(g.x ?? 0, g.y ?? 0);
        ev = { ...g, x: pt.x, y: pt.y };
      }
      const outs: GestureOutput[] = mapGestureToOps(ev, p.desk, mode);
      for (const out of outs) {
        if (out.kind === 'op') p.onOp?.({ op: out.op, args: out.args });
        else if (out.kind === 'annotate') p.onAnnotate?.({ action: out.action, phase: out.phase, x: out.x, y: out.y });
        else if (out.kind === 'keyboard') p.onKeyboardToggle?.();
        else if (out.kind === 'haptic') (p.vibrate ?? ((ms: number) => navigator.vibrate?.(ms)))(10);
        else if (out.kind === 'view') {
          // The midpoint relative to the untransformed video rectangle (its layout position inside `outer`).
          const base = { x: inner.offsetLeft, y: inner.offsetTop };
          const v = viewRef.current;
          const next =
            out.action === 'zoom'
              ? zoomAbout(v, out.scale ?? 1, { x: (out.cx ?? 0) - base.x, y: (out.cy ?? 0) - base.y }, w, h)
              : clampView({ ...v, tx: v.tx + (out.dx ?? 0), ty: v.ty + (out.dy ?? 0) }, w, h);
          viewRef.current = next;
          mode.zoom = next.zoom;
          setView(next);
        }
      }
    }
  }, []);

  useEffect(() => {
    const el = o.outer.current;
    if (!o.enabled || !el) return;
    const now = () => (opts.current.now ?? (() => performance.now()))();
    const stopTimer = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
    const startTimer = () => {
      if (timer.current) return;
      timer.current = setInterval(() => {
        const r = recognizer.current;
        if (!r) return stopTimer();
        apply(r.tick(now()));
        if (!r.busy) stopTimer();
      }, TICK_MS);
    };
    let touchAt = 0;
    const handler = (kind: 'down' | 'move' | 'up' | 'cancel') => (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      if ((e.target as Element | null)?.closest?.('[data-touch-ignore]')) return;
      e.stopPropagation();
      if (kind === 'down' && e.cancelable) e.preventDefault();
      touchAt = now();
      const r = recognizer.current;
      if (!r) return;
      const rect = el.getBoundingClientRect();
      apply(r.push({ t: now(), kind, pointerId: e.pointerId, x: e.clientX - rect.left, y: e.clientY - rect.top }));
      if (r.busy) startTimer();
    };
    const down = handler('down');
    const move = handler('move');
    const up = handler('up');
    const cancel = handler('cancel');
    // A long press on a touch screen also raises the browser's context menu: never on the remote view.
    const menu = (e: Event) => {
      if (now() - touchAt < 1500) e.preventDefault();
    };
    el.addEventListener('pointerdown', down, { capture: true });
    el.addEventListener('pointermove', move, { capture: true });
    el.addEventListener('pointerup', up, { capture: true });
    el.addEventListener('pointercancel', cancel, { capture: true });
    el.addEventListener('contextmenu', menu, { capture: true });
    return () => {
      el.removeEventListener('pointerdown', down, { capture: true });
      el.removeEventListener('pointermove', move, { capture: true });
      el.removeEventListener('pointerup', up, { capture: true });
      el.removeEventListener('pointercancel', cancel, { capture: true });
      el.removeEventListener('contextmenu', menu, { capture: true });
      stopTimer();
    };
  }, [o.enabled, o.outer, apply]);

  const resetZoom = useCallback(() => {
    viewRef.current = IDENTITY;
    setView(IDENTITY);
  }, []);

  const zoomed = view.zoom !== 1;
  return {
    zoom: view.zoom,
    innerStyle: zoomed ? { transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})`, transformOrigin: '0 0' } : {},
    outerStyle: o.enabled ? { touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none', WebkitUserSelect: 'none' } : {},
    cursor: o.trackpad && (o.desk.kind === 'native' || o.desk.kind === 'android') && o.desk.control ? cursor : null,
    resetZoom,
  };
}

/** The zoom level and a way back to 1x (shown only while zoomed). */
export function ZoomChip({ zoom, onReset }: { zoom: number; onReset: () => void }) {
  if (zoom === 1) return null;
  return (
    <div data-touch-ignore="" className="absolute right-2 top-2 z-10 flex items-center gap-2 rounded-md bg-slate-900/85 px-2 py-1 text-sm text-white">
      <span role="status" aria-live="polite">
        Zoom {zoom.toFixed(1)}x
      </span>
      <button type="button" className="min-h-11 min-w-11 rounded bg-white px-2 font-medium text-slate-900" onClick={onReset}>
        Reset zoom
      </button>
    </div>
  );
}

/** The drawn Trackpad cursor, positioned inside the video rectangle (it moves with the view transform). */
export function TrackpadCursor({ at }: { at: { x: number; y: number } | null }) {
  if (!at) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="trackpad-cursor"
      className="pointer-events-none absolute z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-teal-600 shadow"
      style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
    />
  );
}
