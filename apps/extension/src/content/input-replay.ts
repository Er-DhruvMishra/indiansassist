/**
 * Input replay in the page (section 5.4). Coordinates come from the node's client rect (`nx`/`ny`) or the viewport
 * (`vx`/`vy`); the frame rule refuses any hit on an `<iframe>`, `<frame>`, `<object>`, `<embed>` or `<portal>`
 * (`not_supported`, nothing forwarded to CDP). In `dom` mode synthetic events are dispatched (bubbling, composed);
 * text goes in through `execCommand('insertText')` or the prototype value setter plus `input` / `change`.
 * In `debugger` mode the page only resolves coordinates; the worker drives CDP.
 */
const FRAME_TAGS = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'PORTAL']);

export type InputReply = { ok: true; cx?: number; cy?: number; applied?: boolean } | { ok: false; error: 'not_supported' | 'no_target'; message?: string };
export type Modifiers = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
export type NodeLookup = (id: number) => Node | null;

export function resolvePoint(a: { nodeId: number | null; nx?: number; ny?: number; vx: number; vy: number }, lookup: NodeLookup, win: Window): { cx: number; cy: number } {
  const W = win as Window & typeof globalThis;
  const node = a.nodeId !== null ? lookup(a.nodeId) : null;
  if (node && node instanceof W.Element && node.isConnected && a.nx !== undefined && a.ny !== undefined) {
    const r = node.getBoundingClientRect();
    return { cx: r.left + a.nx * r.width, cy: r.top + a.ny * r.height };
  }
  return { cx: a.vx * win.innerWidth, cy: a.vy * win.innerHeight };
}

/** `elementFromPoint`, descending into open shadow roots; frames answer `frame`. */
export function hitTest(doc: Document, cx: number, cy: number): { ok: true; el: Element } | { ok: false; reason: 'frame' | 'none' } {
  let el = doc.elementFromPoint(cx, cy);
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(cx, cy);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (el && FRAME_TAGS.has(el.tagName.toUpperCase())) return { ok: false, reason: 'frame' };
  if (!el) {
    for (const f of doc.querySelectorAll('iframe, frame, object, embed, portal')) {
      const r = f.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return { ok: false, reason: 'frame' };
    }
    return { ok: false, reason: 'none' };
  }
  return { ok: true, el };
}

function mouseInit(cx: number, cy: number, button: number, m: Modifiers): MouseEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button, buttons: button === 0 ? 1 : button === 2 ? 2 : 4, altKey: m.alt, ctrlKey: m.ctrl, metaKey: m.meta, shiftKey: m.shift };
}

function fire(el: Element, type: string, init: MouseEventInit, win: Window, pointer = false): void {
  const W = win as Window & typeof globalThis;
  const Ctor = pointer && typeof W.PointerEvent === 'function' ? W.PointerEvent : W.MouseEvent;
  el.dispatchEvent(new Ctor(type, pointer ? { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true } : init));
}

function scrollableAncestor(el: Element | null, win: Window): Element | null {
  for (let n = el; n; n = n.parentElement) {
    const s = win.getComputedStyle(n);
    if (/(auto|scroll)/.test(`${s.overflowY}${s.overflowX}`) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n;
  }
  return null;
}

export function dispatchPointer(el: Element, kind: string, cx: number, cy: number, button: number, m: Modifiers, win: Window, deltaX = 0, deltaY = 0): void {
  const init = mouseInit(cx, cy, button, m);
  const down = () => {
    fire(el, 'pointerdown', init, win, true);
    fire(el, 'mousedown', init, win);
  };
  const up = () => {
    fire(el, 'pointerup', init, win, true);
    fire(el, 'mouseup', init, win);
  };
  switch (kind) {
    case 'move':
      fire(el, 'pointermove', init, win, true);
      fire(el, 'mousemove', init, win);
      return;
    case 'down':
      return down();
    case 'up':
      return up();
    case 'click':
    case 'dblclick':
      down();
      up();
      (el as HTMLElement).click?.();
      if ((el as HTMLElement).tabIndex >= 0) (el as HTMLElement).focus?.({ preventScroll: true });
      if (kind === 'dblclick') fire(el, 'dblclick', { ...init, detail: 2 }, win);
      return;
    case 'contextmenu':
      fire(el, 'contextmenu', { ...init, button: 2 }, win);
      return;
    case 'wheel': {
      const W = win as Window & typeof globalThis;
      el.dispatchEvent(new W.WheelEvent('wheel', { ...init, deltaX, deltaY }));
      const target = scrollableAncestor(el, win);
      if (target) target.scrollBy?.(deltaX, deltaY);
      else win.scrollBy(deltaX, deltaY);
      return;
    }
  }
}

function isEditable(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return (el as HTMLElement).isContentEditable === true || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
}

/** Sets a value so frameworks see it: the prototype setter, then `input` (and `change` / `blur` on commit). */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, win: Window, commit: boolean): void {
  const W = win as Window & typeof globalThis;
  const proto = el instanceof W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new W.Event('input', { bubbles: true, composed: true }));
  if (commit) {
    el.dispatchEvent(new W.Event('change', { bubbles: true }));
    el.dispatchEvent(new W.FocusEvent('blur'));
  }
}

export function dispatchKey(doc: Document, a: { kind: string; key: string; code: string; modifiers: Modifiers; text?: string }, win: Window): void {
  const W = win as Window & typeof globalThis;
  const target = (doc.activeElement ?? doc.body) as Element;
  const init: KeyboardEventInit = { bubbles: true, cancelable: true, composed: true, key: a.key, code: a.code, altKey: a.modifiers.alt, ctrlKey: a.modifiers.ctrl, metaKey: a.modifiers.meta, shiftKey: a.modifiers.shift };
  if (a.kind === 'down' || a.kind === 'press') target.dispatchEvent(new W.KeyboardEvent('keydown', init));
  if (a.kind === 'press' && a.text && isEditable(target)) {
    const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, a.text);
    if (!inserted && (target instanceof W.HTMLInputElement || target instanceof W.HTMLTextAreaElement)) setNativeValue(target, target.value + a.text, win, false);
  }
  if (a.kind === 'up' || a.kind === 'press') target.dispatchEvent(new W.KeyboardEvent('keyup', init));
}

/** One input op in the page. `mode: 'debugger'` resolves coordinates and the frame rule only. */
export function replayInput(op: string, args: Record<string, unknown>, lookup: NodeLookup, doc: Document, win: Window): InputReply {
  const W = win as Window & typeof globalThis;
  const mode = args.mode === 'debugger' ? 'debugger' : 'dom';
  const mods = (args.modifiers ?? { alt: false, ctrl: false, meta: false, shift: false }) as Modifiers;
  if (op === 'input.key') {
    if (mode === 'dom') dispatchKey(doc, args as never, win);
    return { ok: true };
  }
  if (op === 'input.fill') {
    const node = lookup(Number(args.nodeId));
    if (!(node instanceof W.HTMLInputElement || node instanceof W.HTMLTextAreaElement) || !node.isConnected) return { ok: false, error: 'no_target', message: 'not a text field' };
    if (node instanceof W.HTMLInputElement && node.type === 'password') return { ok: true, applied: false };
    node.focus({ preventScroll: true });
    setNativeValue(node, String(args.value ?? ''), win, args.commit === true);
    return { ok: true, applied: true };
  }
  const point =
    op === 'input.scroll'
      ? resolvePoint({ nodeId: (args.nodeId as number | null) ?? null, nx: 0.5, ny: 0.5, vx: 0.5, vy: 0.5 }, lookup, win)
      : resolvePoint(args as { nodeId: number | null; vx: number; vy: number }, lookup, win);
  const hit = hitTest(doc, point.cx, point.cy);
  if (!hit.ok) return hit.reason === 'frame' ? { ok: false, error: 'not_supported', message: 'cross-origin frame' } : { ok: false, error: 'no_target', message: 'nothing at that point' };
  if (mode === 'debugger') return { ok: true, cx: point.cx, cy: point.cy };
  if (op === 'input.scroll') {
    const node = args.nodeId !== null ? lookup(Number(args.nodeId)) : null;
    if (node instanceof W.Element) node.scrollBy?.(Number(args.dx), Number(args.dy));
    else win.scrollBy(Number(args.dx), Number(args.dy));
    return { ok: true };
  }
  dispatchPointer(hit.el, String(args.kind), point.cx, point.cy, Number(args.button ?? 0), mods, win, Number(args.deltaX ?? 0), Number(args.deltaY ?? 0));
  return { ok: true, cx: point.cx, cy: point.cy };
}
