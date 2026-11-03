/**
 * Phase F section 7.2 / 15.6: the gesture recognizer and the mapping, replayed from `fixtures/touch/gestures.json`
 * (every row of the table for each Desk kind and zoom state, Trackpad mode, no kind change mid-gesture), plus the
 * recognizer's own rules (ticks, busy, reset, the zoom clamp).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GESTURE_CONFIG,
  clampZoom,
  createGestureRecognizer,
  deskUsesDoubleTap,
  mapGestureToOps,
  type GestureConfig,
  type GestureDesk,
  type GestureEvent,
  type GestureMode,
  type GestureOutput,
  type TouchSample,
} from '../src/index.js';

type Case = {
  name: string;
  desk: GestureDesk;
  mode: GestureMode;
  config?: Partial<GestureConfig>;
  samples: [number, TouchSample['kind'], number, number, number][];
  end: number;
  expect: GestureOutput[];
};

const fixture = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/touch/gestures.json'), 'utf8')) as {
  view: { w: number; h: number };
  cases: Case[];
};

function normalise(g: GestureEvent, w: number, h: number): GestureEvent {
  if (g.kind === 'pinch' || g.kind === 'three_finger_tap') return g;
  if (g.kind === 'two_finger_drag') return { ...g, x: (g.x ?? 0) / w, y: (g.y ?? 0) / h };
  return { ...g, x: g.x / w, y: g.y / h };
}

/** Rounds every number to 6 decimals (and -0 to 0) so floating pinch factors compare. */
function round(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6 + 0;
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
}

function replay(c: Case): GestureOutput[] {
  const r = createGestureRecognizer({ ...DEFAULT_GESTURE_CONFIG, ...c.config }, c.mode);
  const events: GestureEvent[] = [];
  for (const [t, kind, pointerId, x, y] of c.samples) events.push(...r.push({ t, kind, pointerId, x, y }));
  events.push(...r.tick(c.end));
  return events.flatMap((g) => mapGestureToOps(normalise(g, fixture.view.w, fixture.view.h), c.desk, c.mode));
}

describe('gesture fixtures (section 7.2)', () => {
  it('has a case for every gesture, Desk kind and zoom state', () => {
    const names = fixture.cases.map((c) => c.name).join('\n');
    for (const g of ['tap', 'double tap', 'long press', 'one-finger drag', 'two-finger drag', 'pinch', 'three-finger tap', 'Trackpad', 'P2'])
      expect(names).toContain(g);
    const kinds = new Set(fixture.cases.map((c) => c.desk.kind));
    for (const k of ['native', 'android', 'p1', 'p2', 'none']) expect(kinds.has(k as GestureDesk['kind'])).toBe(true);
    expect(fixture.cases.some((c) => c.mode.zoom > 1)).toBe(true);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(round(replay(c))).toEqual(round(c.expect));
    });
  }
});

describe('recognizer rules', () => {
  const tap = (r: ReturnType<typeof createGestureRecognizer>, t: number, x = 10, y = 10) => [
    ...r.push({ t, kind: 'down', pointerId: 1, x, y }),
    ...r.push({ t: t + 50, kind: 'up', pointerId: 1, x, y }),
  ];

  it('reports a tap at once when double tap means nothing, and only after the window otherwise', () => {
    const now = createGestureRecognizer({ ...DEFAULT_GESTURE_CONFIG, doubleTapGapMs: 0 }, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
    expect(tap(now, 0)).toEqual([{ kind: 'tap', x: 10, y: 10 }]);
    expect(now.busy).toBe(false);
    const later = createGestureRecognizer(DEFAULT_GESTURE_CONFIG, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
    expect(tap(later, 0)).toEqual([]);
    expect(later.busy).toBe(true);
    expect(later.tick(200)).toEqual([]);
    expect(later.tick(351)).toEqual([{ kind: 'tap', x: 10, y: 10 }]);
    expect(later.busy).toBe(false);
  });

  it('a long press fires on a tick while the finger is still down', () => {
    const r = createGestureRecognizer(DEFAULT_GESTURE_CONFIG, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
    r.push({ t: 0, kind: 'down', pointerId: 4, x: 5, y: 6 });
    expect(r.tick(499)).toEqual([]);
    expect(r.tick(500)).toEqual([{ kind: 'long_press', x: 5, y: 6 }]);
    expect(r.push({ t: 900, kind: 'up', pointerId: 4, x: 5, y: 6 })).toEqual([]);
  });

  it('a pinch never becomes a two-finger drag, and lifting one finger does not start a one-finger gesture', () => {
    const r = createGestureRecognizer(DEFAULT_GESTURE_CONFIG, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
    r.push({ t: 0, kind: 'down', pointerId: 1, x: 0, y: 0 });
    r.push({ t: 5, kind: 'down', pointerId: 2, x: 100, y: 0 });
    expect(r.push({ t: 10, kind: 'move', pointerId: 2, x: 200, y: 0 })[0]!.kind).toBe('pinch');
    const later = [
      ...r.push({ t: 20, kind: 'move', pointerId: 1, x: 0, y: 300 }),
      ...r.push({ t: 30, kind: 'move', pointerId: 2, x: 200, y: 300 }),
    ];
    expect(later.every((g) => g.kind === 'pinch')).toBe(true);
    expect(r.push({ t: 40, kind: 'up', pointerId: 2, x: 200, y: 300 })).toEqual([]);
    expect(r.push({ t: 50, kind: 'move', pointerId: 1, x: 50, y: 350 })).toEqual([]);
    expect(r.push({ t: 60, kind: 'up', pointerId: 1, x: 50, y: 350 })).toEqual([]);
    expect(r.busy).toBe(false);
  });

  it('reset forgets a pending tap', () => {
    const r = createGestureRecognizer(DEFAULT_GESTURE_CONFIG, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
    tap(r, 0);
    r.reset();
    expect(r.tick(1000)).toEqual([]);
  });

  it('clamps zoom to 1x..4x and knows which Desks use double tap', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(deskUsesDoubleTap({ kind: 'native', control: true })).toBe(true);
    expect(deskUsesDoubleTap({ kind: 'native', control: false })).toBe(false);
    expect(deskUsesDoubleTap({ kind: 'p1', control: false })).toBe(false);
  });

  it('pinch maps to a local zoom only, whatever the Desk', () => {
    for (const kind of ['native', 'android', 'p1', 'p2', 'none'] as const) {
      const out = mapGestureToOps({ kind: 'pinch', scale: 2, cx: 1, cy: 2 }, { kind, control: true });
      expect(out).toEqual([{ kind: 'view', action: 'zoom', scale: 2, cx: 1, cy: 2 }]);
    }
  });
});
