/**
 * Phase F sections 7.2 and 15.6: the touch layer with synthetic touch pointer events. Ops are emitted with
 * coordinates normalised to the video rectangle through a zoomed view; pinch zooms and sends nothing; a long press is
 * a right click with a haptic tick; two fingers scroll; mouse and pen pointers reach the existing `InputOverlay`
 * exactly as before and touch never does; in P1 a tap is a laser ping and a drag draws.
 */
import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DcAnnot, GestureDesk } from '@indiansassist/shared';
import { InputOverlay, type OverlayActions } from '../src/assist/console/agent/InputOverlay';
import { RemoteView } from '../src/assist/console/RemoteView';
import { EMPTY_ANNOT } from '../src/lib/annotation';
import { clampView, useTouchSurface, zoomAbout, type TouchOp } from '../src/assist/touch/TouchSurface';

const W = 1000;
const H = 500;
let clock = 0;

/** jsdom has no layout: the outer box is W x H at (0, 0) and the inner rect follows its transform style. */
function layout(outer: HTMLElement, inner: HTMLElement) {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  outer.getBoundingClientRect = () => rect(0, 0, W, H);
  inner.getBoundingClientRect = () => {
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(inner.style.transform);
    return m ? rect(Number(m[1]), Number(m[2]), W * Number(m[3]), H * Number(m[3])) : rect(0, 0, W, H);
  };
}

function ptr(el: Element, type: string, id: number, x: number, y: number, pointerType = 'touch', button = 0) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: pointerType } });
  act(() => {
    el.dispatchEvent(e);
  });
}

/** Advances the injected clock and the surface's tick timer. */
function advance(ms: number) {
  clock += ms;
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function Harness({ desk, onOp, overlay, vibrate }: { desk: GestureDesk; onOp: (o: TouchOp) => void; overlay?: OverlayActions; vibrate?: (ms: number) => void }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const s = useTouchSurface({ outer, inner, enabled: true, desk, trackpad: false, scrollWhileZoomed: false, onOp, now: () => clock, vibrate });
  return (
    <div ref={outer} data-testid="outer" style={s.outerStyle}>
      <div ref={inner} data-testid="inner" style={s.innerStyle}>
        {overlay && <InputOverlay monitorId={1} enabled actions={overlay} label="Control monitor 1" />}
      </div>
      <span data-testid="zoom">{s.zoom}</span>
    </div>
  );
}

function mount(desk: GestureDesk, overlay?: OverlayActions) {
  const ops: TouchOp[] = [];
  const vibrate = vi.fn();
  render(<Harness desk={desk} onOp={(o) => ops.push(o)} overlay={overlay} vibrate={vibrate} />);
  layout(screen.getByTestId('outer'), screen.getByTestId('inner'));
  return { ops, vibrate, outer: screen.getByTestId('outer') };
}

function overlayActions() {
  return { pointer: vi.fn(), scroll: vi.fn(), key: vi.fn(), text: vi.fn(), clipboard: vi.fn(), release: vi.fn() } satisfies OverlayActions;
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('touch on a controlled native Desk', () => {
  it('a tap clicks button 0 at the normalised point (after the double-tap window)', () => {
    const { ops, outer } = mount({ kind: 'native', control: true });
    ptr(outer, 'pointerdown', 1, 250, 100);
    advance(60);
    ptr(outer, 'pointerup', 1, 250, 100);
    expect(ops).toEqual([]);
    advance(400);
    expect(ops).toEqual([{ op: 'os.pointer', args: { kind: 'click', nx: 0.25, ny: 0.2, button: 0 } }]);
  });

  it('a long press is a right click with a haptic tick', () => {
    const { ops, outer, vibrate } = mount({ kind: 'native', control: true });
    ptr(outer, 'pointerdown', 1, 500, 250);
    advance(600);
    ptr(outer, 'pointerup', 1, 500, 250);
    expect(ops).toEqual([{ op: 'os.pointer', args: { kind: 'click', nx: 0.5, ny: 0.5, button: 2 } }]);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('pinch zooms the view and sends nothing; a tap then lands at the point under the finger', () => {
    const { ops, outer } = mount({ kind: 'native', control: true });
    // Fingers 200 px apart about (250, 125), spread to 400 px: zoom 2 about that midpoint.
    ptr(outer, 'pointerdown', 1, 150, 125);
    ptr(outer, 'pointerdown', 2, 350, 125);
    advance(20);
    ptr(outer, 'pointermove', 1, 50, 125);
    ptr(outer, 'pointermove', 2, 450, 125);
    ptr(outer, 'pointerup', 1, 50, 125);
    ptr(outer, 'pointerup', 2, 450, 125);
    advance(500);
    expect(ops).toEqual([]);
    expect(Number(screen.getByTestId('zoom').textContent)).toBeCloseTo(2, 5);
    // Two steps (finger 1, then finger 2): x1.5 about (200, 125), then x4/3 about (250, 125).
    expect(screen.getByTestId('inner').style.transform).toBe('translate(-216.66666666666669px, -125px) scale(2)');
    // Unzoomed, (750, 125) is (0.75, 0.25); through the zoom it is ((750 + 216.67) / 2000, (125 + 125) / 1000).
    ptr(outer, 'pointerdown', 3, 750, 125);
    advance(50);
    ptr(outer, 'pointerup', 3, 750, 125);
    advance(400);
    expect(ops).toEqual([{ op: 'os.pointer', args: { kind: 'click', nx: 0.4833, ny: 0.25, button: 0 } }]);
  });

  it('two fingers at zoom 1 scroll one notch per 40 px, inverted like a trackpad', () => {
    const { ops, outer } = mount({ kind: 'native', control: true });
    ptr(outer, 'pointerdown', 1, 400, 300);
    ptr(outer, 'pointerdown', 2, 600, 300);
    for (const y of [280, 260, 240, 220]) {
      advance(20);
      ptr(outer, 'pointermove', 1, 400, y);
      ptr(outer, 'pointermove', 2, 600, y);
    }
    ptr(outer, 'pointerup', 1, 400, 220);
    ptr(outer, 'pointerup', 2, 600, 220);
    expect(ops.map((o) => o.op)).toEqual(['os.scroll', 'os.scroll']);
    expect(ops.every((o) => o.args['dy'] === 1 && o.args['dx'] === 0)).toBe(true);
  });

  it('a one-finger drag is down, moves and up', () => {
    const { ops, outer } = mount({ kind: 'native', control: true });
    ptr(outer, 'pointerdown', 1, 100, 100);
    advance(30);
    ptr(outer, 'pointermove', 1, 200, 100);
    advance(30);
    ptr(outer, 'pointermove', 1, 300, 100);
    ptr(outer, 'pointerup', 1, 300, 100);
    expect(ops.map((o) => o.args['kind'])).toEqual(['down', 'move', 'move', 'up']);
    expect(ops[3]!.args).toEqual({ kind: 'up', nx: 0.3, ny: 0.2, button: 0 });
  });
});

describe('mouse, pen and touch on the InputOverlay', () => {
  it('mouse and pen reach the overlay unchanged; touch never does', () => {
    const actions = overlayActions();
    const { ops } = mount({ kind: 'native', control: true }, actions);
    const overlay = screen.getByRole('application', { name: 'Control monitor 1' });
    expect(overlay.className).toContain('touch-none');
    ptr(overlay, 'pointerdown', 7, 100, 50, 'mouse', 0);
    ptr(overlay, 'pointerup', 7, 100, 50, 'mouse', 0);
    ptr(overlay, 'pointerdown', 8, 100, 50, 'pen', 0);
    expect(actions.pointer.mock.calls.map((c) => c[1])).toEqual(['down', 'up', 'down']);
    expect(ops).toEqual([]);
    actions.pointer.mockClear();
    ptr(overlay, 'pointerdown', 9, 100, 50, 'touch');
    ptr(overlay, 'pointerup', 9, 100, 50, 'touch');
    advance(400);
    expect(actions.pointer).not.toHaveBeenCalled();
    expect(ops).toHaveLength(1);
  });
});

describe('without control', () => {
  it('a tap sends nothing; a one-finger drag pans only while zoomed', () => {
    const { ops, outer } = mount({ kind: 'native', control: false });
    ptr(outer, 'pointerdown', 1, 500, 250);
    ptr(outer, 'pointerup', 1, 500, 250);
    advance(400);
    ptr(outer, 'pointerdown', 1, 100, 100);
    advance(20);
    ptr(outer, 'pointermove', 1, 300, 100);
    ptr(outer, 'pointerup', 1, 300, 100);
    expect(ops).toEqual([]);
    expect(screen.getByTestId('inner').style.transform).toBe('');
  });
});

describe('view transform math', () => {
  it('zooms about a point and clamps to the video rectangle', () => {
    expect(zoomAbout({ zoom: 1, tx: 0, ty: 0 }, 2, { x: 250, y: 125 }, W, H)).toEqual({ zoom: 2, tx: -250, ty: -125 });
    expect(zoomAbout({ zoom: 2, tx: -250, ty: -125 }, 4, { x: 0, y: 0 }, W, H).zoom).toBe(4);
    expect(clampView({ zoom: 2, tx: 100, ty: -900 }, W, H)).toEqual({ zoom: 2, tx: 0, ty: -500 });
    expect(clampView({ zoom: 0.5, tx: -10, ty: -10 }, W, H)).toEqual({ zoom: 1, tx: 0, ty: 0 });
  });
});

describe('P1 annotation by touch (RemoteView)', () => {
  function mountView(tool: 'rect' | null) {
    const annots: DcAnnot[] = [];
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    const { container } = render(
      <RemoteView
        stream={{} as MediaStream}
        annot={EMPTY_ANNOT}
        tool={tool}
        color="#ef4444"
        fit
        watermark={{ name: 'Asha', userId: 'u1', sessionId: 's1' }}
        description="Remote screen"
        onAnnot={(m) => annots.push(m)}
        onCanvas={() => undefined}
        emptyText="No video yet."
        touch={{ desk: { kind: 'p1', control: false }, trackpad: false, scrollWhileZoomed: false, annotate: true }}
      />,
    );
    const canvas = screen.getByRole('img', { name: 'Remote screen' });
    const inner = canvas.parentElement as HTMLElement;
    const outer = inner.parentElement as HTMLElement;
    layout(outer, inner);
    void container;
    return { annots, outer };
  }

  it('a tap is a laser ping at once', () => {
    const { annots, outer } = mountView(null);
    ptr(outer, 'pointerdown', 1, 500, 125);
    ptr(outer, 'pointerup', 1, 500, 125);
    expect(annots).toHaveLength(1);
    expect(annots[0]).toMatchObject({ shape: 'pointer', at: { x: 0.5, y: 0.25 }, color: '#ef4444' });
  });

  it('a drag with the rectangle tool draws one rectangle', async () => {
    const { annots, outer } = mountView('rect');
    ptr(outer, 'pointerdown', 1, 100, 100);
    advance(20);
    ptr(outer, 'pointermove', 1, 300, 200);
    advance(20);
    ptr(outer, 'pointermove', 1, 400, 300);
    ptr(outer, 'pointerup', 1, 400, 300);
    await act(async () => {
      await Promise.resolve();
    });
    expect(annots).toHaveLength(1);
    expect(annots[0]).toMatchObject({ shape: 'rect', a: { x: 0.1, y: 0.2 }, b: { x: 0.4, y: 0.6 } });
  });

  it('pinch zooms the P1 view and sends no annotation', () => {
    const { annots, outer } = mountView(null);
    ptr(outer, 'pointerdown', 1, 400, 250);
    ptr(outer, 'pointerdown', 2, 600, 250);
    advance(20);
    ptr(outer, 'pointermove', 2, 800, 250);
    ptr(outer, 'pointerup', 1, 400, 250);
    ptr(outer, 'pointerup', 2, 800, 250);
    expect(annots).toEqual([]);
    expect(screen.getByRole('status').textContent).toMatch(/Zoom 2\.0x/);
    act(() => screen.getByRole('button', { name: 'Reset zoom' }).click());
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull();
  });
});
