/**
 * Annotation geometry and state (contracts section 8.2). Coordinates are normalised floats 0..1 relative
 * to the shared video frame's intrinsic size, origin top-left, rounded to 4 decimals. The element that
 * shows the frame may letterbox it (`object-fit: contain`), so pointer positions are mapped through the
 * content box first. Pure functions: unit tested without a DOM.
 */
import {
  DEFAULT_ANNOT_COLOR,
  LIMITS,
  roundCoord,
  type DcAnnot,
} from '@indiansassist/shared';
import { uuid } from './ids';

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type BoxShape = 'arrow' | 'rect' | 'highlight';
export type AnnotTool = BoxShape | 'pointer';

/**
 * The rectangle inside an element of `elW x elH` CSS px where a frame of `frameW x frameH` is drawn with
 * `object-fit: contain` (centred, aspect preserved). With `fill` the frame covers the element.
 */
export function contentBox(elW: number, elH: number, frameW: number, frameH: number, fit: 'contain' | 'fill' = 'contain'): Box {
  if (fit === 'fill' || frameW <= 0 || frameH <= 0 || elW <= 0 || elH <= 0) return { x: 0, y: 0, w: elW, h: elH };
  const scale = Math.min(elW / frameW, elH / frameH);
  const w = frameW * scale;
  const h = frameH * scale;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/**
 * Element-relative CSS px (e.g. `clientX - rect.left`) -> normalised frame coordinates, or null when the
 * point is in the letterbox outside the frame. Results are clamped to 0..1 and rounded to 4 decimals.
 */
export function normalisePoint(
  px: number,
  py: number,
  elW: number,
  elH: number,
  frameW: number,
  frameH: number,
  fit: 'contain' | 'fill' = 'contain',
): Point | null {
  const b = contentBox(elW, elH, frameW, frameH, fit);
  if (b.w <= 0 || b.h <= 0) return null;
  const rx = (px - b.x) / b.w;
  const ry = (py - b.y) / b.h;
  const eps = 1e-9;
  if (rx < -eps || ry < -eps || rx > 1 + eps || ry > 1 + eps) return null;
  return { x: roundCoord(rx), y: roundCoord(ry) };
}

/** Normalised frame coordinates -> element-relative CSS px (the inverse of `normalisePoint`). */
export function denormalisePoint(p: Point, box: Box): Point {
  return { x: box.x + p.x * box.w, y: box.y + p.y * box.h };
}

/** Clamps an arbitrary drag end point to the frame (dragging past the edge still draws to the edge). */
export function clampNormalised(px: number, py: number, box: Box): Point {
  return { x: roundCoord((px - box.x) / box.w), y: roundCoord((py - box.y) / box.h) };
}

export function makeBoxAnnot(
  shape: BoxShape,
  a: Point,
  b: Point,
  color: string = DEFAULT_ANNOT_COLOR,
  ttlMs: number = LIMITS.annotTtlDefaultMs,
  now: number = Date.now(),
): DcAnnot {
  return {
    t: 'annot',
    id: uuid(),
    shape,
    a: { x: roundCoord(a.x), y: roundCoord(a.y) },
    b: { x: roundCoord(b.x), y: roundCoord(b.y) },
    color,
    ttlMs: Math.min(LIMITS.annotTtlMaxMs, Math.max(1, Math.round(ttlMs))),
    ts: now,
  };
}

export function makePointer(at: Point, color: string = DEFAULT_ANNOT_COLOR, id: string = uuid(), now = Date.now()): DcAnnot {
  return { t: 'annot', id, shape: 'pointer', at: { x: roundCoord(at.x), y: roundCoord(at.y) }, color, ts: now };
}

export function makeClear(now = Date.now()): DcAnnot {
  return { t: 'annot', shape: 'clear', ts: now };
}

export type LiveShape = { id: string; shape: BoxShape; a: Point; b: Point; color: string; expiresAt: number };
export type AnnotState = { shapes: LiveShape[]; pointer: { at: Point; color: string } | null };

export const EMPTY_ANNOT: AnnotState = { shapes: [], pointer: null };

/** Applies one annotation message to the state (TTL measured from local receipt time `now`). */
export function applyAnnot(state: AnnotState, msg: DcAnnot, now: number = Date.now()): AnnotState {
  switch (msg.shape) {
    case 'clear':
      return EMPTY_ANNOT;
    case 'pointer':
      return { ...state, pointer: { at: msg.at, color: msg.color } };
    default:
      return {
        ...state,
        shapes: [
          ...state.shapes.filter((s) => s.id !== msg.id),
          { id: msg.id, shape: msg.shape, a: msg.a, b: msg.b, color: msg.color, expiresAt: now + msg.ttlMs },
        ],
      };
  }
}

/** Drops expired shapes; returns the same object when nothing changed (cheap re-render check). */
export function pruneAnnot(state: AnnotState, now: number = Date.now()): AnnotState {
  const shapes = state.shapes.filter((s) => s.expiresAt > now);
  return shapes.length === state.shapes.length ? state : { ...state, shapes };
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Draws shapes and pointer onto a 2D context whose drawing surface maps the frame to `box`. */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  state: AnnotState,
  box: Box,
  draft?: { shape: BoxShape; a: Point; b: Point; color: string } | null,
): void {
  const unit = Math.max(2, Math.round(Math.min(box.w, box.h) / 300));
  const all = draft ? [...state.shapes, { ...draft, id: 'draft', expiresAt: Infinity }] : state.shapes;
  for (const s of all) {
    const a = denormalisePoint(s.a, box);
    const b = denormalisePoint(s.b, box);
    ctx.save();
    ctx.lineWidth = unit * 2;
    ctx.strokeStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.shape === 'rect') {
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.shape === 'highlight') {
      ctx.fillStyle = hexToRgba(s.color, 0.3);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = unit * 8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    ctx.restore();
  }
  if (state.pointer) {
    const p = denormalisePoint(state.pointer.at, box);
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, unit * 6, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(state.pointer.color, 0.45);
    ctx.fill();
    ctx.lineWidth = unit;
    ctx.strokeStyle = state.pointer.color;
    ctx.stroke();
    ctx.restore();
  }
}
