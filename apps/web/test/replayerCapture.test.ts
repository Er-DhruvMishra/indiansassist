/** Replayer frame capture helpers (Phase B 10.2): node id, normalised coordinates, mask counting, fit scale. */
import { describe, expect, it } from 'vitest';
import { countMasked, fitScale, hitTest, isMaskedElement } from '../src/replayer/capture';

function fakeDoc(el: Element | null): Document {
  return { elementFromPoint: () => el } as unknown as Document;
}

describe('replayer capture', () => {
  it('maps a point to the mirror id with node- and viewport-relative coordinates', () => {
    const el = document.createElement('button');
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 40, right: 300, bottom: 90, x: 100, y: 50, toJSON: () => ({}) });
    const hit = hitTest(fakeDoc(el), 150, 60, 1000, 500, () => 42);
    expect(hit).toEqual({ nodeId: 42, nx: 0.25, ny: 0.25, vx: 0.15, vy: 0.12, masked: false });
  });

  it('returns nodeId null (and no nx/ny) for an unknown node or empty point', () => {
    const el = document.createElement('div');
    expect(hitTest(fakeDoc(el), 10, 10, 100, 100, () => -1)).toEqual({ nodeId: null, vx: 0.1, vy: 0.1, masked: false });
    expect(hitTest(fakeDoc(null), 500, 500, 100, 100, () => 1)).toEqual({ nodeId: null, vx: 1, vy: 1, masked: false });
  });

  it('recognises and counts masked values and text', () => {
    document.body.innerHTML = '<input value="*****"><input value="plain"><textarea>********</textarea><p>********</p><p>Hello</p>';
    const input = document.querySelector('input')!;
    expect(isMaskedElement(input)).toBe(true);
    expect(isMaskedElement(document.querySelectorAll('p')[1]!)).toBe(false);
    expect(countMasked(document)).toBeGreaterThanOrEqual(3);
    document.body.innerHTML = '';
  });

  it('fits the mirrored viewport into the frame without upscaling', () => {
    expect(fitScale(1920, 1080, 960, 1080)).toBe(0.5);
    expect(fitScale(800, 600, 1600, 1200)).toBe(1);
    expect(fitScale(0, 0, 100, 100)).toBe(1);
  });
});
