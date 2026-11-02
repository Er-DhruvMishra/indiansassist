/**
 * Phase F section 7.2 (docs/specs/phase-f-contracts.md): the touch gesture recognizer, a pure state machine over
 * touch points and time, and its mapping to Desk ops. The foundation lands the types and the thresholds; the mobile
 * stream fills `createGestureRecognizer` and `mapGestureToOps` (and may refine these types in the same change as
 * this contract).
 */
import { notBuilt } from '../enterprise/not-built.js';

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
  doubleTapGapMs: number;
  doubleTapRadiusPx: number;
  longPressMs: number;
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

/** The view state a recognizer needs (zoom, the Trackpad and Scroll toggles). */
export type GestureMode = {
  zoom: number;
  trackpad: boolean;
  /** The toolbar "Scroll" toggle: two-finger drag sends `os.scroll` while zoomed. */
  scrollWhileZoomed: boolean;
};

/** A recognised gesture; points are normalised (0..1) to the monitor's video rectangle after the view transform. */
export type GestureEvent =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'double_tap'; x: number; y: number }
  | { kind: 'long_press'; x: number; y: number }
  | { kind: 'drag'; phase: 'start' | 'move' | 'end'; x: number; y: number }
  | { kind: 'two_finger_drag'; dx: number; dy: number }
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
  /** Feeds one sample; returns the gestures it completes or advances. */
  push(sample: TouchSample): GestureEvent[];
  /** Advances time with no sample (long press, double-tap window). */
  tick(t: number): GestureEvent[];
  reset(): void;
};

/** Mobile stream. */
export function createGestureRecognizer(config: GestureConfig, mode: GestureMode): GestureRecognizer {
  void config;
  void mode;
  return notBuilt('mobile', 'createGestureRecognizer');
}

/** Mobile stream: the section 7.2 table for one gesture and Desk. */
export function mapGestureToOps(gesture: GestureEvent, desk: GestureDesk): GestureOutput[] {
  void gesture;
  void desk;
  return notBuilt('mobile', 'mapGestureToOps');
}
