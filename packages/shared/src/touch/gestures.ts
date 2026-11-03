/**
 * Phase F section 7.2 (docs/specs/phase-f-contracts.md): the touch gesture recognizer, a pure state machine over
 * touch points and time, and its mapping to Desk ops. No DOM, no clock: the caller feeds samples and ticks.
 *
 * Coordinates: the recognizer works in the coordinate space of its samples (CSS px relative to the view element);
 * thresholds are CSS px. The caller normalises a gesture's point (`x`, `y`) to the monitor's video rectangle
 * **after** the view transform before `mapGestureToOps`, so zoom never changes where an op lands; deltas (`dx`,
 * `dy`), the pinch midpoint (`cx`, `cy`) and `scale` stay in sample units, because they drive the local view.
 *
 * Rules the state machine keeps:
 * - a gesture that starts as one kind never turns into another (no scroll after a pinch was recognised, no second
 *   finger joining a drag);
 * - a tap is reported at once when double tap means nothing for the Desk (`doubleTapGapMs: 0`), otherwise after the
 *   double-tap window, so a double tap never reaches the Desk as click + double click;
 * - a cancelled drag still ends (`drag end`), so no button stays held on the Desk.
 */

/** One touch pointer sample, coordinates in CSS px relative to the view element. */
export type TouchSample = {
  t: number;
  kind: 'down' | 'move' | 'up' | 'cancel';
  pointerId: number;
  x: number;
  y: number;
};

/** The section 7.2 thresholds (CSS px and ms). */
export type GestureConfig = {
  tapMovePx: number;
  tapMaxMs: number;
  /** 0 = report taps immediately (no double tap). */
  doubleTapGapMs: number;
  doubleTapRadiusPx: number;
  longPressMs: number;
  /**
   * Section 7.2 names a drag as "moved > 8 px within 150 ms of the press"; a slower start (before the long press)
   * is a drag too, so a deliberate press-and-move is never lost. Kept for the table and the fixtures.
   */
  dragStartMs: number;
  dragMoveIntervalMs: number;
  /** A two-finger gesture whose finger distance changes by at least this fraction is a pinch. */
  pinchRatio: number;
  scrollNotchPx: number;
  zoomMin: number;
  zoomMax: number;
};

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  tapMovePx: 8,
  tapMaxMs: 500,
  doubleTapGapMs: 300,
  doubleTapRadiusPx: 24,
  longPressMs: 500,
  dragStartMs: 150,
  dragMoveIntervalMs: 16,
  pinchRatio: 0.15,
  scrollNotchPx: 40,
  zoomMin: 1,
  zoomMax: 4,
};

/** Which Desk the console drives and how (section 7.2 columns). */
export type GestureDesk = {
  kind: 'native' | 'android' | 'p1' | 'p2' | 'none';
  /** Control granted (native, Android, P2 `in_page` / `deep`). */
  control: boolean;
};

/** The view state the mapping needs (zoom, the Trackpad and Scroll toggles). */
export type GestureMode = {
  zoom: number;
  trackpad: boolean;
  /** The toolbar "Scroll" toggle: two-finger drag sends `os.scroll` while zoomed. */
  scrollWhileZoomed: boolean;
};

export const DEFAULT_GESTURE_MODE: GestureMode = { zoom: 1, trackpad: false, scrollWhileZoomed: false };

/**
 * A recognised gesture. `x`, `y`: the point (sample units out of the recognizer, normalised 0..1 by the caller before
 * `mapGestureToOps`). `dx`, `dy`: movement since the previous event of the gesture, sample units. `notchesX`,
 * `notchesY`: whole `scrollNotchPx` steps of finger movement crossed by this event (accumulated by the recognizer).
 * `scale`: the pinch factor since the previous pinch event; `cx`, `cy`: the finger midpoint, sample units.
 */
export type GestureEvent =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'double_tap'; x: number; y: number }
  | { kind: 'long_press'; x: number; y: number }
  | { kind: 'drag'; phase: 'start' | 'move' | 'end'; x: number; y: number; dx?: number; dy?: number }
  | { kind: 'two_finger_drag'; dx: number; dy: number; x?: number; y?: number; notchesX?: number; notchesY?: number }
  | { kind: 'pinch'; scale: number; cx: number; cy: number }
  | { kind: 'three_finger_tap' };

/** What a gesture becomes: an op through the existing controller paths, or a local view or annotation action. */
export type GestureOutput =
  | { kind: 'op'; op: string; args: Record<string, unknown> }
  | { kind: 'view'; action: 'zoom' | 'pan'; scale?: number; dx?: number; dy?: number; cx?: number; cy?: number }
  | { kind: 'annotate'; action: 'laser' | 'draw'; phase?: 'start' | 'move' | 'end'; x: number; y: number }
  | { kind: 'keyboard'; action: 'toggle' }
  | { kind: 'haptic' };

export type GestureRecognizer = {
  /** Feeds one sample; returns the gestures it completes or advances (time-based ones due by `sample.t` first). */
  push(sample: TouchSample): GestureEvent[];
  /** Advances time with no sample (long press, double-tap window). */
  tick(t: number): GestureEvent[];
  /** Replaces the mode (zoom and toggles); the gesture in progress keeps its kind. */
  setMode(mode: GestureMode): void;
  /** Forgets everything (a pending tap is dropped, a drag is not ended). */
  reset(): void;
  /** True while a gesture is in progress or a tap waits for its double-tap window. */
  readonly busy: boolean;
};

type Pt = { x: number; y: number };
type Finger = Pt & { start: Pt };
type State =
  | { s: 'idle' }
  /** One finger down, not yet a tap, drag or long press. */
  | { s: 'press'; t0: number; at: Pt; second: Pt | null }
  | { s: 'drag'; last: Pt; emitted: Pt; lastEmitAt: number }
  | { s: 'long' }
  /** Two fingers down, not yet a pinch or a two-finger drag. */
  | { s: 'two'; t0: number; d0: number; m0: Pt }
  | { s: 'pinch'; dPrev: number }
  | { s: 'scroll'; mPrev: Pt; accX: number; accY: number }
  | { s: 'three'; t0: number }
  /** The gesture is over (or refused); everything is ignored until the last finger lifts. */
  | { s: 'done' };

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Section 7.2: the recognizer. `mode` is kept for the mapping's callers and future rules; recognition ignores zoom. */
export function createGestureRecognizer(config: GestureConfig, mode: GestureMode = DEFAULT_GESTURE_MODE): GestureRecognizer {
  const c = config;
  let fingers = new Map<number, Finger>();
  let st: State = { s: 'idle' };
  /** A tap waiting for the double-tap window. */
  let pendingTap: { at: Pt; upAt: number } | null = null;
  let currentMode = mode;
  void currentMode;

  const flushTap = (out: GestureEvent[]) => {
    if (!pendingTap) return;
    out.push({ kind: 'tap', x: pendingTap.at.x, y: pendingTap.at.y });
    pendingTap = null;
  };

  const twoPoints = (): [Finger, Finger] | null => {
    const f = [...fingers.values()];
    return f.length >= 2 ? [f[0]!, f[1]!] : null;
  };

  const tick = (t: number): GestureEvent[] => {
    const out: GestureEvent[] = [];
    if (pendingTap && st.s !== 'press' && t - pendingTap.upAt > c.doubleTapGapMs) flushTap(out);
    if (st.s === 'press' && t - st.t0 >= c.longPressMs) {
      // A press that was the second tap candidate and is held is a long press; the first tap stands on its own.
      flushTap(out);
      out.push({ kind: 'long_press', x: st.at.x, y: st.at.y });
      st = { s: 'long' };
    }
    if (st.s === 'two' && t - st.t0 >= c.longPressMs) st = { s: 'done' };
    return out;
  };

  const endIfEmpty = () => {
    if (fingers.size === 0) st = { s: 'idle' };
    else if (st.s !== 'idle') st = { s: 'done' };
  };

  const onDown = (p: TouchSample, out: GestureEvent[]) => {
    fingers.set(p.pointerId, { x: p.x, y: p.y, start: { x: p.x, y: p.y } });
    const at = { x: p.x, y: p.y };
    switch (st.s) {
      case 'idle': {
        let second: Pt | null = null;
        if (pendingTap) {
          if (p.t - pendingTap.upAt <= c.doubleTapGapMs && dist(pendingTap.at, at) <= c.doubleTapRadiusPx) second = pendingTap.at;
          else flushTap(out);
        }
        st = { s: 'press', t0: p.t, at, second };
        return;
      }
      case 'press': {
        // An undecided one-finger press (no drag, no long press yet) + a second finger = a two-finger gesture.
        flushTap(out);
        const pts = twoPoints()!;
        st = { s: 'two', t0: p.t, d0: Math.max(1, dist(pts[0], pts[1])), m0: mid(pts[0], pts[1]) };
        return;
      }
      case 'two':
        st = fingers.size === 3 && p.t - st.t0 <= c.tapMaxMs ? { s: 'three', t0: st.t0 } : { s: 'done' };
        return;
      case 'three':
        st = { s: 'done' };
        return;
      default:
        // drag, long, pinch, scroll, done: the gesture keeps its kind; the extra finger is ignored.
        return;
    }
  };

  const onMove = (p: TouchSample, out: GestureEvent[]) => {
    const f = fingers.get(p.pointerId);
    if (!f) return;
    f.x = p.x;
    f.y = p.y;
    switch (st.s) {
      case 'press': {
        if (dist(f.start, f) <= c.tapMovePx) return;
        flushTap(out);
        const start = st.at;
        out.push({ kind: 'drag', phase: 'start', x: start.x, y: start.y, dx: 0, dy: 0 });
        out.push({ kind: 'drag', phase: 'move', x: f.x, y: f.y, dx: f.x - start.x, dy: f.y - start.y });
        st = { s: 'drag', last: { x: f.x, y: f.y }, emitted: { x: f.x, y: f.y }, lastEmitAt: p.t };
        return;
      }
      case 'drag': {
        // Only the finger that started the drag moves it (the first one in the map).
        if ([...fingers.keys()][0] !== p.pointerId) return;
        st.last = { x: f.x, y: f.y };
        if (p.t - st.lastEmitAt < c.dragMoveIntervalMs) return;
        out.push({ kind: 'drag', phase: 'move', x: f.x, y: f.y, dx: f.x - st.emitted.x, dy: f.y - st.emitted.y });
        st.emitted = { x: f.x, y: f.y };
        st.lastEmitAt = p.t;
        return;
      }
      case 'two': {
        const pts = twoPoints();
        if (!pts) return;
        const d = dist(pts[0], pts[1]);
        const m = mid(pts[0], pts[1]);
        if (Math.abs(d / st.d0 - 1) >= c.pinchRatio) {
          out.push({ kind: 'pinch', scale: d / st.d0, cx: m.x, cy: m.y });
          st = { s: 'pinch', dPrev: Math.max(1, d) };
        } else if (dist(m, st.m0) > c.tapMovePx) {
          const dx = m.x - st.m0.x;
          const dy = m.y - st.m0.y;
          const next = { s: 'scroll' as const, mPrev: m, accX: dx, accY: dy };
          const nx = Math.trunc(next.accX / c.scrollNotchPx);
          const ny = Math.trunc(next.accY / c.scrollNotchPx);
          next.accX -= nx * c.scrollNotchPx;
          next.accY -= ny * c.scrollNotchPx;
          out.push({ kind: 'two_finger_drag', x: m.x, y: m.y, dx, dy, notchesX: nx, notchesY: ny });
          st = next;
        }
        return;
      }
      case 'pinch': {
        const pts = twoPoints();
        if (!pts) return;
        const d = Math.max(1, dist(pts[0], pts[1]));
        const m = mid(pts[0], pts[1]);
        if (d === st.dPrev) return;
        out.push({ kind: 'pinch', scale: d / st.dPrev, cx: m.x, cy: m.y });
        st.dPrev = d;
        return;
      }
      case 'scroll': {
        const pts = twoPoints();
        if (!pts) return;
        const m = mid(pts[0], pts[1]);
        const dx = m.x - st.mPrev.x;
        const dy = m.y - st.mPrev.y;
        if (dx === 0 && dy === 0) return;
        st.accX += dx;
        st.accY += dy;
        const nx = Math.trunc(st.accX / c.scrollNotchPx);
        const ny = Math.trunc(st.accY / c.scrollNotchPx);
        st.accX -= nx * c.scrollNotchPx;
        st.accY -= ny * c.scrollNotchPx;
        st.mPrev = m;
        out.push({ kind: 'two_finger_drag', x: m.x, y: m.y, dx, dy, notchesX: nx, notchesY: ny });
        return;
      }
      case 'three':
        if (dist(f.start, f) > c.tapMovePx) st = { s: 'done' };
        return;
      default:
        return;
    }
  };

  const onUp = (p: TouchSample, out: GestureEvent[], cancelled: boolean) => {
    const f = fingers.get(p.pointerId);
    if (!f) return;
    if (!cancelled) {
      f.x = p.x;
      f.y = p.y;
    }
    switch (st.s) {
      case 'press': {
        fingers.delete(p.pointerId);
        if (cancelled || p.t - st.t0 >= c.tapMaxMs) {
          pendingTap = null;
          return endIfEmpty();
        }
        if (st.second) {
          out.push({ kind: 'double_tap', x: st.second.x, y: st.second.y });
          pendingTap = null;
        } else if (c.doubleTapGapMs > 0) {
          pendingTap = { at: st.at, upAt: p.t };
        } else {
          out.push({ kind: 'tap', x: st.at.x, y: st.at.y });
        }
        return endIfEmpty();
      }
      case 'drag': {
        const first = [...fingers.keys()][0] === p.pointerId;
        fingers.delete(p.pointerId);
        if (!first) return;
        const end = cancelled ? st.last : { x: f.x, y: f.y };
        out.push({ kind: 'drag', phase: 'end', x: end.x, y: end.y, dx: end.x - st.emitted.x, dy: end.y - st.emitted.y });
        return endIfEmpty();
      }
      case 'three': {
        fingers.delete(p.pointerId);
        if (!cancelled && p.t - st.t0 <= c.tapMaxMs) out.push({ kind: 'three_finger_tap' });
        return endIfEmpty();
      }
      default:
        fingers.delete(p.pointerId);
        return endIfEmpty();
    }
  };

  return {
    push(sample) {
      const out = tick(sample.t);
      if (sample.kind === 'down') onDown(sample, out);
      else if (sample.kind === 'move') onMove(sample, out);
      else onUp(sample, out, sample.kind === 'cancel');
      return out;
    },
    tick,
    setMode(m) {
      currentMode = m;
    },
    reset() {
      fingers = new Map();
      st = { s: 'idle' };
      pendingTap = null;
    },
    get busy() {
      return st.s !== 'idle' || pendingTap !== null;
    },
  };
}

const r4 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

/** True when the Desk gives a double tap a meaning (the caller sets `doubleTapGapMs: 0` otherwise). */
export function deskUsesDoubleTap(desk: GestureDesk): boolean {
  return desk.control && (desk.kind === 'native' || desk.kind === 'android' || desk.kind === 'p2');
}

/**
 * Section 7.2: the table for one gesture, Desk and mode. Native and Android Desks get `os.pointer` / `os.scroll` ops
 * (`monitorId` and modifiers are the caller's); a P2 Desk gets `rp.pointer` / `rp.wheel` captures (the replayer
 * frame's existing path, section 7.1); P1 gets annotation actions; pinch is always a local zoom and never input.
 * In Trackpad mode the caller substitutes its drawn cursor for the point; a drag only moves it.
 */
export function mapGestureToOps(gesture: GestureEvent, desk: GestureDesk, mode: GestureMode = DEFAULT_GESTURE_MODE): GestureOutput[] {
  const zoomed = mode.zoom > 1;
  const native = (desk.kind === 'native' || desk.kind === 'android') && desk.control;
  const p2 = desk.kind === 'p2' && desk.control;
  const p1 = desk.kind === 'p1';
  const pan = (dx = 0, dy = 0): GestureOutput[] => (zoomed && (dx !== 0 || dy !== 0) ? [{ kind: 'view', action: 'pan', dx, dy }] : []);
  const pointer = (kind: string, x: number, y: number, button = 0): GestureOutput => ({ kind: 'op', op: 'os.pointer', args: { kind, nx: r4(x), ny: r4(y), button } });
  const rp = (kind: string, x: number, y: number, button = 0): GestureOutput => ({ kind: 'op', op: 'rp.pointer', args: { kind, x: r4(x), y: r4(y), button } });

  switch (gesture.kind) {
    case 'pinch':
      return [{ kind: 'view', action: 'zoom', scale: gesture.scale, cx: gesture.cx, cy: gesture.cy }];
    case 'tap':
      if (native) return [pointer('click', gesture.x, gesture.y)];
      if (p2) return [rp('click', gesture.x, gesture.y)];
      if (p1) return [{ kind: 'annotate', action: 'laser', x: r4(gesture.x), y: r4(gesture.y) }];
      return [];
    case 'double_tap':
      if (native) return [pointer('dblclick', gesture.x, gesture.y)];
      if (p2) return [rp('dblclick', gesture.x, gesture.y)];
      return [];
    case 'long_press':
      if (native) return [pointer('click', gesture.x, gesture.y, 2), { kind: 'haptic' }];
      if (p2) return [rp('contextmenu', gesture.x, gesture.y, 2), { kind: 'haptic' }];
      return [];
    case 'drag':
      if (native) {
        if (mode.trackpad) return gesture.phase === 'end' ? [] : [pointer('move', gesture.x, gesture.y)];
        return [pointer(gesture.phase === 'start' ? 'down' : gesture.phase === 'end' ? 'up' : 'move', gesture.x, gesture.y)];
      }
      if (p1) return [{ kind: 'annotate', action: 'draw', phase: gesture.phase, x: r4(gesture.x), y: r4(gesture.y) }];
      return pan(gesture.dx, gesture.dy);
    case 'two_finger_drag': {
      const scroll = !zoomed || mode.scrollWhileZoomed;
      if (native && scroll) {
        // Inverted like a trackpad: fingers moving up scroll the content down (positive notches).
        const dx = -(gesture.notchesX ?? 0);
        const dy = -(gesture.notchesY ?? 0);
        if (dx === 0 && dy === 0) return [];
        const clamp = (n: number) => Math.max(-20, Math.min(20, n));
        return [{ kind: 'op', op: 'os.scroll', args: { nx: r4(gesture.x ?? 0.5), ny: r4(gesture.y ?? 0.5), dx: clamp(dx) + 0, dy: clamp(dy) + 0 } }];
      }
      if (p2 && scroll) {
        if (gesture.dx === 0 && gesture.dy === 0) return [];
        return [{ kind: 'op', op: 'rp.wheel', args: { x: r4(gesture.x ?? 0.5), y: r4(gesture.y ?? 0.5), deltaX: -gesture.dx + 0, deltaY: -gesture.dy + 0 } }];
      }
      return pan(gesture.dx, gesture.dy);
    }
    case 'three_finger_tap':
      return native ? [{ kind: 'keyboard', action: 'toggle' }] : [];
  }
}

/** Section 7.2: the zoom after a pinch factor, clamped to `zoomMin`..`zoomMax`. */
export function clampZoom(zoom: number, config: GestureConfig = DEFAULT_GESTURE_CONFIG): number {
  if (!Number.isFinite(zoom)) return config.zoomMin;
  return Math.min(config.zoomMax, Math.max(config.zoomMin, zoom));
}
