/**
 * Input capture helpers of the replayer frame (Phase B 10.2): map a click on the transparent overlay to the
 * mirrored document (`elementFromPoint` in rrweb's inner iframe), the rrweb mirror id, node-relative and
 * viewport-relative normalised coordinates, and count masked nodes for the masking indicator.
 */
export type Mods = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
export type Hit = { nodeId: number | null; nx?: number; ny?: number; vx: number; vy: number; masked: boolean };

const MASK_RE = /^\*+$/;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function modsOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Mods {
  return { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
}

/** True when the element shows only mask characters (a masked input value or masked text). */
export function isMaskedElement(el: Element | null): boolean {
  if (!el) return false;
  const v = (el as HTMLInputElement).value;
  if (typeof v === 'string' && v.length > 0 && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return MASK_RE.test(v);
  const t = (el.textContent ?? '').trim();
  return t.length > 0 && MASK_RE.test(t);
}

/**
 * `x`/`y` are CSS px inside the mirrored viewport (overlay offset divided by the scale); `vw`/`vh` the latest Meta
 * size of the tab. `getId` is the replayer mirror's lookup (`-1` for an unknown node, which becomes `null`).
 */
export function hitTest(doc: Document | null, x: number, y: number, vw: number, vh: number, getId: (n: Node) => number): Hit {
  const vx = clamp01(vw > 0 ? x / vw : 0);
  const vy = clamp01(vh > 0 ? y / vh : 0);
  const el = doc?.elementFromPoint?.(x, y) ?? null;
  if (!el) return { nodeId: null, vx, vy, masked: false };
  const id = getId(el);
  if (typeof id !== 'number' || id < 0) return { nodeId: null, vx, vy, masked: false };
  const r = el.getBoundingClientRect();
  const nx = clamp01(r.width > 0 ? (x - r.left) / r.width : 0.5);
  const ny = clamp01(r.height > 0 ? (y - r.top) / r.height : 0.5);
  return { nodeId: id, nx, ny, vx, vy, masked: isMaskedElement(el) };
}

/** Counts masked form values and masked text nodes in the mirrored document. */
export function countMasked(doc: Document | null): number {
  if (!doc?.body) return 0;
  let n = 0;
  for (const el of Array.from(doc.querySelectorAll('input, textarea'))) {
    const v = (el as HTMLInputElement).value;
    if (typeof v === 'string' && v.length > 0 && MASK_RE.test(v)) n += 1;
  }
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = (node.nodeValue ?? '').trim();
    if (t.length > 0 && MASK_RE.test(t)) n += 1;
  }
  return n;
}

/** Scale that fits a `w x h` viewport into the frame (never upscales). */
export function fitScale(w: number, h: number, boxW: number, boxH: number): number {
  if (w <= 0 || h <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min(1, boxW / w, boxH / h);
}
