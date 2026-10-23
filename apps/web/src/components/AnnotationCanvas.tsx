/**
 * Annotation overlay canvas (contracts section 8.2). Draws the live annotation state over a frame and,
 * when a `tool` is given (Assist), turns pointer gestures into normalised annotation messages.
 * `frameW` / `frameH` are the frame's intrinsic size; `fit` says how the frame is laid out in the element.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DcAnnot } from '@indiansassist/shared';
import {
  clampNormalised,
  contentBox,
  drawAnnotations,
  makeBoxAnnot,
  makePointer,
  normalisePoint,
  type AnnotState,
  type AnnotTool,
  type BoxShape,
  type Point,
} from '../lib/annotation';
import { uuid } from '../lib/ids';

/** 2D context or null (jsdom and some locked-down browsers have no canvas). */
export function safeContext(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return c.getContext('2d');
  } catch {
    return null;
  }
}

type Props = {
  state: AnnotState;
  frameW: number;
  frameH: number;
  fit?: 'contain' | 'fill';
  tool?: AnnotTool | null;
  color?: string;
  onAnnot?: (msg: DcAnnot) => void;
  label?: string;
};

export function AnnotationCanvas({ state, frameW, frameH, fit = 'fill', tool = null, color = '#f59e0b', onAnnot, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<{ shape: BoxShape; a: Point; b: Point; color: string } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const pointerId = useRef(uuid());
  const lastPointerSent = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || size.w === 0 || size.h === 0) return;
    const dpr = globalThis.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    const ctx = safeContext(el);
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    drawAnnotations(ctx, state, contentBox(size.w, size.h, frameW, frameH, fit), draft);
  }, [state, draft, size, frameW, frameH, fit]);

  const local = useCallback((e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }, []);

  const sendPointer = (p: Point, force: boolean) => {
    const now = Date.now();
    if (!force && now - lastPointerSent.current < 50) return;
    lastPointerSent.current = now;
    onAnnot?.(makePointer(p, color, pointerId.current, now));
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!tool || !onAnnot) return;
    const l = local(e);
    const p = normalisePoint(l.x, l.y, l.w, l.h, frameW, frameH, fit);
    if (!p) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (tool === 'pointer') sendPointer(p, true);
    else setDraft({ shape: tool, a: p, b: p, color });
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!tool || !onAnnot) return;
    const l = local(e);
    const box = contentBox(l.w, l.h, frameW, frameH, fit);
    if (tool === 'pointer') {
      if (e.buttons & 1) sendPointer(clampNormalised(l.x, l.y, box), false);
      return;
    }
    if (draft) setDraft({ ...draft, b: clampNormalised(l.x, l.y, box) });
  };

  const onUp = () => {
    if (!draft || !onAnnot) return;
    const { shape, a, b } = draft;
    setDraft(null);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.005) return;
    onAnnot(makeBoxAnnot(shape, a, b, color));
  };

  return (
    <canvas
      ref={ref}
      aria-label={label}
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      className={`absolute inset-0 h-full w-full ${tool ? 'cursor-crosshair touch-none' : 'pointer-events-none'}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDraft(null)}
    />
  );
}
