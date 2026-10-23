import { describe, expect, it } from 'vitest';
import { dcAnnotSchema } from '@indiansassist/shared';
import {
  EMPTY_ANNOT,
  applyAnnot,
  clampNormalised,
  contentBox,
  denormalisePoint,
  makeBoxAnnot,
  makeClear,
  makePointer,
  normalisePoint,
  pruneAnnot,
} from '../src/lib/annotation';

describe('contentBox', () => {
  it('letterboxes a 16:9 frame inside a 4:3 element (bars top and bottom)', () => {
    const b = contentBox(800, 600, 1920, 1080);
    expect(b.w).toBe(800);
    expect(b.h).toBeCloseTo(450);
    expect(b.x).toBe(0);
    expect(b.y).toBeCloseTo(75);
  });

  it('pillarboxes a 4:3 frame inside a 16:9 element (bars left and right)', () => {
    const b = contentBox(1600, 900, 1024, 768);
    expect(b.h).toBe(900);
    expect(b.w).toBeCloseTo(1200);
    expect(b.x).toBeCloseTo(200);
    expect(b.y).toBe(0);
  });

  it('fill mode and unknown frame sizes use the whole element', () => {
    expect(contentBox(800, 600, 1920, 1080, 'fill')).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(contentBox(800, 600, 0, 0)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe('normalisePoint', () => {
  it('maps the element centre to the frame centre', () => {
    expect(normalisePoint(400, 300, 800, 600, 1920, 1080)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('maps the corners of the content box to 0 and 1', () => {
    expect(normalisePoint(0, 75, 800, 600, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(normalisePoint(800, 525, 800, 600, 1920, 1080)).toEqual({ x: 1, y: 1 });
  });

  it('returns null inside the letterbox bars', () => {
    expect(normalisePoint(400, 10, 800, 600, 1920, 1080)).toBeNull();
    expect(normalisePoint(400, 590, 800, 600, 1920, 1080)).toBeNull();
    expect(normalisePoint(100, 450, 1600, 900, 1024, 768)).toBeNull();
  });

  it('rounds to 4 decimals (section 8.2)', () => {
    const p = normalisePoint(123.456789, 200.987654, 800, 600, 800, 600, 'fill')!;
    expect(p.x).toBe(0.1543);
    expect(p.y).toBe(0.335);
    expect(String(p.x).split('.')[1]!.length).toBeLessThanOrEqual(4);
  });

  it('is resolution independent: the same relative spot on two element sizes gives the same point', () => {
    const a = normalisePoint(200, 150, 800, 600, 1280, 720)!;
    const b = normalisePoint(400, 300, 1600, 1200, 1280, 720)!;
    expect(a).toEqual(b);
  });
});

describe('denormalise and clamp', () => {
  it('denormalise inverts normalise', () => {
    const box = contentBox(800, 600, 1920, 1080);
    const p = normalisePoint(250, 300, 800, 600, 1920, 1080)!;
    const back = denormalisePoint(p, box);
    expect(back.x).toBeCloseTo(250, 0);
    expect(back.y).toBeCloseTo(300, 0);
  });

  it('clamps drags past the frame edge to 0..1', () => {
    const box = { x: 0, y: 75, w: 800, h: 450 };
    expect(clampNormalised(-50, 0, box)).toEqual({ x: 0, y: 0 });
    expect(clampNormalised(900, 700, box)).toEqual({ x: 1, y: 1 });
  });
});

describe('annotation messages and state', () => {
  it('builds messages that pass the shared schema', () => {
    const arrow = makeBoxAnnot('arrow', { x: 0.123456, y: 0.2 }, { x: 0.9, y: 0.8 }, '#ef4444', 5000, 1000);
    expect(dcAnnotSchema.safeParse(arrow).success).toBe(true);
    expect(arrow).toMatchObject({ shape: 'arrow', a: { x: 0.1235, y: 0.2 }, ttlMs: 5000 });
    expect(dcAnnotSchema.safeParse(makePointer({ x: 0.5, y: 0.5 })).success).toBe(true);
    expect(dcAnnotSchema.safeParse(makeClear()).success).toBe(true);
  });

  it('caps ttl at 60 s', () => {
    expect(makeBoxAnnot('rect', { x: 0, y: 0 }, { x: 1, y: 1 }, '#f59e0b', 999999)).toMatchObject({ ttlMs: 60000 });
  });

  it('applies shapes, replaces the pointer, clears everything, and expires by ttl', () => {
    const rect = makeBoxAnnot('rect', { x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, '#f59e0b', 1000, 0);
    let s = applyAnnot(EMPTY_ANNOT, rect, 0);
    s = applyAnnot(s, makePointer({ x: 0.3, y: 0.3 }, '#f59e0b', 'p1'), 0);
    s = applyAnnot(s, makePointer({ x: 0.4, y: 0.4 }, '#f59e0b', 'p1'), 0);
    expect(s.shapes).toHaveLength(1);
    expect(s.pointer?.at).toEqual({ x: 0.4, y: 0.4 });
    expect(pruneAnnot(s, 500)).toBe(s);
    expect(pruneAnnot(s, 1500).shapes).toHaveLength(0);
    expect(applyAnnot(s, makeClear())).toEqual(EMPTY_ANNOT);
  });

  it('re-sending a shape with the same id replaces it', () => {
    const a = makeBoxAnnot('highlight', { x: 0, y: 0 }, { x: 0.5, y: 0.5 });
    if (a.shape !== 'highlight') throw new Error('unexpected shape');
    const s = applyAnnot(applyAnnot(EMPTY_ANNOT, a), { ...a, b: { x: 0.6, y: 0.6 } });
    expect(s.shapes).toHaveLength(1);
    expect(s.shapes[0]!.b).toEqual({ x: 0.6, y: 0.6 });
  });
});
