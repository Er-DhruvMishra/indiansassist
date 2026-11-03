/**
 * The sandboxed replayer frame (`/replayer.html`, Phase B 10.2). Runs with a hash-only CSP (no network, no
 * frames, no other script) inside `<iframe sandbox="allow-scripts allow-same-origin">`: an opaque origin cannot
 * work because sandbox flags are inherited and rrweb's own inner iframe would be unreachable (see
 * `replayerBridge.ts`). It accepts commands only from `window.parent` on its own origin, validates them, sanitises every rrweb event again (section 12.3) and drives one live
 * `Replayer` per tab (at most 4). A transparent overlay captures pointer and keyboard input and posts it to the
 * parent as `rp.*` messages; nothing from the mirrored page can run (rrweb's inner iframe has no `allow-scripts`).
 *
 * Phase F section 7.1: touch on the overlay runs through the shared gesture recognizer and becomes the same captures
 * a mouse makes: a tap is `rp.pointer click`, a double tap `dblclick`, a long press a `contextmenu` pointer event
 * (button 2), a two-finger drag `rp.wheel` deltas; pinch zooms the mirror locally (1x-4x) and sends nothing. The
 * compatibility mouse events a browser fires after a touch are ignored, so nothing is sent twice.
 */
import { Replayer } from 'rrweb';
import rrwebCss from 'rrweb/dist/style.css?inline';
import { DEFAULT_GESTURE_CONFIG, clampZoom, createGestureRecognizer, mapGestureToOps, sanitiseRrwebEvent, type GestureEvent } from '@indiansassist/shared';
import { MAX_LIVE_REPLAYERS, parentMessageSchema, type ArmMode, type ParentMessage, type ReplayerMessage } from '../assist/console/mirror/replayerProtocol';
import { countMasked, fitScale, hitTest, modsOf, type Mods } from './capture';

type Live = { replayer: Replayer; host: HTMLDivElement; width: number; height: number };
type RrEvent = { type: number; timestamp: number; data?: { width?: number; height?: number } };

const EV_META = 4;
const style = document.createElement('style');
style.textContent = rrwebCss;
document.head.appendChild(style);
const stage = document.getElementById('stage') as HTMLDivElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const live = new Map<number, Live>();
const order: number[] = [];
let focused: number | null = null;
let armed: ArmMode = 'off';
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let lastMove = 0;
/** Phase F section 7.1: the local view zoom (pinch) and pan, and when the last touch happened. */
let zoom = 1;
let panX = 0;
let panY = 0;
let lastTouchAt = -Infinity;

/** Same-origin frame: talk to exactly our own origin; an opaque frame (origin 'null') can only use '*'. */
const TARGET = self.origin === 'null' ? '*' : self.origin;

function post(msg: ReplayerMessage): void {
  window.parent.postMessage(msg, TARGET);
}

function clean(events: unknown[]): RrEvent[] {
  const out: RrEvent[] = [];
  for (const e of events) {
    let c: unknown;
    try {
      c = sanitiseRrwebEvent(e);
    } catch {
      c = null;
    }
    if (c && typeof c === 'object' && typeof (c as RrEvent).type === 'number' && typeof (c as RrEvent).timestamp === 'number') out.push(c as RrEvent);
  }
  return out;
}

function destroy(tabId: number): void {
  const l = live.get(tabId);
  if (!l) return;
  try {
    l.replayer.destroy();
  } catch {
    /* already gone */
  }
  l.host.remove();
  live.delete(tabId);
  const i = order.indexOf(tabId);
  if (i >= 0) order.splice(i, 1);
}

function touch(tabId: number): void {
  const i = order.indexOf(tabId);
  if (i >= 0) order.splice(i, 1);
  order.unshift(tabId);
  while (order.length > MAX_LIVE_REPLAYERS) destroy(order[order.length - 1]!);
}

function layout(): void {
  for (const [tabId, l] of live) {
    const show = tabId === focused;
    l.host.style.display = show ? 'block' : 'none';
    if (!show) continue;
    const s = fitScale(l.width, l.height, window.innerWidth, window.innerHeight);
    l.replayer.wrapper.style.transform = zoom === 1 ? `scale(${s})` : `translate(${panX}px, ${panY}px) scale(${s * zoom})`;
    l.replayer.wrapper.style.transformOrigin = '0 0';
  }
}

/** Section 7.1: keeps the zoomed mirror covering its fitted box (no empty band inside it). */
function clampPan(): void {
  const l = focused === null ? undefined : live.get(focused);
  const s = l ? fitScale(l.width, l.height, window.innerWidth, window.innerHeight) : 1;
  const w = (l?.width ?? window.innerWidth) * s;
  const h = (l?.height ?? window.innerHeight) * s;
  zoom = clampZoom(zoom);
  if (zoom === 1) {
    panX = 0;
    panY = 0;
    return;
  }
  panX = Math.min(0, Math.max(w * (1 - zoom), panX));
  panY = Math.min(0, Math.max(h * (1 - zoom), panY));
}

function resetZoom(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
}

function trackMeta(l: Live, events: RrEvent[]): void {
  for (const e of events) {
    if (e.type === EV_META && e.data && typeof e.data.width === 'number' && typeof e.data.height === 'number') {
      l.width = e.data.width;
      l.height = e.data.height;
    }
  }
}

function scheduleStats(): void {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    if (focused === null) return;
    const l = live.get(focused);
    post({ t: 'rp.maskStats', tabId: focused, masked: countMasked(l?.replayer.iframe.contentDocument ?? null), revealed: 0 });
  }, 400);
}

function snapshot(tabId: number, raw: unknown[]): void {
  destroy(tabId);
  const events = clean(raw);
  if (events.length === 0) return post({ t: 'rp.error', tabId, message: 'empty snapshot' });
  const host = document.createElement('div');
  host.className = 'tab-host';
  stage.appendChild(host);
  const replayer = new Replayer(events as never[], {
    root: host,
    liveMode: true,
    skipInactive: false,
    mouseTail: false,
    UNSAFE_replayCanvas: false,
    useVirtualDom: true,
    triggerFocus: false,
    pauseAnimation: false,
    showWarning: false,
    insertStyleRules: ['[data-ia-block]{outline:1px dashed #94a3b8}'],
  });
  const l: Live = { replayer, host, width: 0, height: 0 };
  trackMeta(l, events);
  live.set(tabId, l);
  touch(tabId);
  replayer.on('fullsnapshot-rebuilded', () => {
    post({ t: 'rp.applied', tabId, kind: 'snapshot' });
    layout();
    scheduleStats();
  });
  replayer.startLive(events[0]!.timestamp - 250);
  layout();
}

function addEvents(tabId: number, raw: unknown[]): void {
  const l = live.get(tabId);
  if (!l) return;
  const events = clean(raw);
  trackMeta(l, events);
  for (const e of events) l.replayer.addEvent(e as never);
  if (events.some((e) => e.type === EV_META)) layout();
  if (tabId === focused) scheduleStats();
}

function onCommand(m: ParentMessage): void {
  switch (m.t) {
    case 'rp.snapshot':
      return snapshot(m.tabId, m.events);
    case 'rp.events':
      return addEvents(m.tabId, m.events);
    case 'rp.reset':
      if (m.tabId === undefined) for (const id of [...live.keys()]) destroy(id);
      else destroy(m.tabId);
      return;
    case 'rp.focus':
      if (m.tabId !== focused) resetZoom();
      focused = m.tabId;
      if (m.tabId !== null && live.has(m.tabId)) touch(m.tabId);
      layout();
      scheduleStats();
      return;
    case 'rp.setSize':
      return layout();
    case 'rp.arm':
      armed = m.mode;
      overlay.style.cursor = armed === 'reveal' ? 'help' : armed === 'input' ? 'default' : 'not-allowed';
      return;
  }
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window.parent || (TARGET !== '*' && ev.origin !== TARGET)) return;
  const p = parentMessageSchema.safeParse(ev.data);
  if (!p.success) return;
  try {
    onCommand(p.data);
  } catch (e) {
    post({ t: 'rp.error', message: String(e).slice(0, 500) });
  }
});
window.addEventListener('resize', layout);

// ---------- input capture ----------

function locateAt(clientX: number, clientY: number) {
  if (focused === null) return null;
  const l = live.get(focused);
  if (!l || l.width <= 0) return null;
  const rect = l.replayer.wrapper.getBoundingClientRect();
  // The wrapper's scale is the fit scale times the local zoom (section 7.1); its rect already includes the pan.
  const s = fitScale(l.width, l.height, window.innerWidth, window.innerHeight) * zoom;
  const x = (clientX - rect.left) / s;
  const y = (clientY - rect.top) / s;
  const mirror = l.replayer.getMirror();
  return { tabId: focused, hit: hitTest(l.replayer.iframe.contentDocument, x, y, l.width, l.height, (n) => mirror.getId(n as never)) };
}

function locate(e: MouseEvent) {
  return locateAt(e.clientX, e.clientY);
}

function pointerAt(kind: 'move' | 'click' | 'dblclick' | 'contextmenu', clientX: number, clientY: number, button: 0 | 1 | 2, modifiers: Mods): void {
  if (armed === 'off' || (armed === 'reveal' && kind !== 'click')) return;
  const at = locateAt(clientX, clientY);
  if (!at) return;
  const h = at.hit;
  const msg: ReplayerMessage = { t: 'rp.pointer', tabId: at.tabId, kind, nodeId: h.nodeId, vx: h.vx, vy: h.vy, button, modifiers, masked: h.masked };
  if (h.nodeId !== null && h.nx !== undefined && h.ny !== undefined) Object.assign(msg, { nx: h.nx, ny: h.ny });
  post(msg);
}

/** A mouse event the browser synthesised from a touch (handled by the gesture recognizer instead). */
function fromTouch(e: MouseEvent): boolean {
  if ((e as PointerEvent).pointerType === 'touch') return true;
  if ((e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents === true) return true;
  return performance.now() - lastTouchAt < 800;
}

function pointer(kind: 'move' | 'click' | 'dblclick' | 'contextmenu', e: MouseEvent): void {
  if (fromTouch(e)) return;
  const button = (e.button === 1 || e.button === 2 ? e.button : 0) as 0 | 1 | 2;
  pointerAt(kind, e.clientX, e.clientY, button, modsOf(e));
}

overlay.addEventListener('mousemove', (e) => {
  const now = performance.now();
  if (now - lastMove < 33) return;
  lastMove = now;
  if (armed === 'input') pointer('move', e);
});
overlay.addEventListener('click', (e) => {
  overlay.focus({ preventScroll: true });
  pointer('click', e);
});
overlay.addEventListener('dblclick', (e) => pointer('dblclick', e));
overlay.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  pointer('contextmenu', e);
});

// ---------- touch (Phase F section 7.1) ----------

const NO_MODS: Mods = { alt: false, ctrl: false, meta: false, shift: false };
const gestures = createGestureRecognizer(DEFAULT_GESTURE_CONFIG, { zoom: 1, trackpad: false, scrollWhileZoomed: false });
let touchTimer: ReturnType<typeof setInterval> | null = null;
overlay.style.touchAction = 'none';
overlay.style.setProperty('-webkit-touch-callout', 'none');
overlay.style.userSelect = 'none';

function applyTouch(events: GestureEvent[]): void {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  for (const g of events) {
    const ev: GestureEvent = g.kind === 'pinch' || g.kind === 'three_finger_tap' ? g : g.kind === 'two_finger_drag' ? { ...g, x: (g.x ?? 0) / w, y: (g.y ?? 0) / h } : { ...g, x: g.x / w, y: g.y / h };
    // `reveal` keeps a tap (it picks the field); `off` leaves only the local zoom and pan.
    const desk = { kind: 'p2' as const, control: armed !== 'off' };
    for (const out of mapGestureToOps(ev, desk, { zoom, trackpad: false, scrollWhileZoomed: false })) {
      if (out.kind === 'op' && out.op === 'rp.pointer') {
        const a = out.args as { kind: 'click' | 'dblclick' | 'contextmenu'; x: number; y: number; button: 0 | 1 | 2 };
        pointerAt(a.kind, a.x * w, a.y * h, a.button, NO_MODS);
      } else if (out.kind === 'op' && out.op === 'rp.wheel') {
        if (armed !== 'input') continue;
        const a = out.args as { x: number; y: number; deltaX: number; deltaY: number };
        const at = locateAt(a.x * w, a.y * h);
        if (at) post({ t: 'rp.wheel', tabId: at.tabId, nodeId: at.hit.nodeId, vx: at.hit.vx, vy: at.hit.vy, deltaX: a.deltaX, deltaY: a.deltaY });
      } else if (out.kind === 'haptic') {
        navigator.vibrate?.(10);
      } else if (out.kind === 'view') {
        if (out.action === 'zoom') {
          const next = clampZoom(zoom * (out.scale ?? 1));
          const cx = out.cx ?? 0;
          const cy = out.cy ?? 0;
          panX = cx - (next * (cx - panX)) / zoom;
          panY = cy - (next * (cy - panY)) / zoom;
          zoom = next;
        } else {
          panX += out.dx ?? 0;
          panY += out.dy ?? 0;
        }
        clampPan();
        layout();
      }
    }
  }
}

const onTouch = (kind: 'down' | 'move' | 'up' | 'cancel') => (e: PointerEvent) => {
  if (e.pointerType !== 'touch') return;
  if (kind === 'down' && e.cancelable) e.preventDefault();
  lastTouchAt = performance.now();
  applyTouch(gestures.push({ t: performance.now(), kind, pointerId: e.pointerId, x: e.clientX, y: e.clientY }));
  if (gestures.busy && !touchTimer) {
    touchTimer = setInterval(() => {
      applyTouch(gestures.tick(performance.now()));
      if (!gestures.busy && touchTimer) {
        clearInterval(touchTimer);
        touchTimer = null;
      }
    }, 40);
  }
};
overlay.addEventListener('pointerdown', onTouch('down'));
overlay.addEventListener('pointermove', onTouch('move'));
overlay.addEventListener('pointerup', onTouch('up'));
overlay.addEventListener('pointercancel', onTouch('cancel'));
overlay.addEventListener(
  'wheel',
  (e) => {
    if (armed !== 'input') return;
    e.preventDefault();
    const at = locate(e);
    if (at) post({ t: 'rp.wheel', tabId: at.tabId, nodeId: at.hit.nodeId, vx: at.hit.vx, vy: at.hit.vy, deltaX: e.deltaX, deltaY: e.deltaY });
  },
  { passive: false },
);
const key = (kind: 'down' | 'up') => (e: KeyboardEvent) => {
  if (armed !== 'input' || focused === null || !e.key) return;
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return; // keep keyboard focus movable out of the frame
  e.preventDefault();
  post({ t: 'rp.key', tabId: focused, kind, key: e.key.slice(0, 64), code: e.code.slice(0, 64), modifiers: modsOf(e) });
};
overlay.addEventListener('keydown', key('down'));
overlay.addEventListener('keyup', key('up'));

post({ t: 'rp.ready' });
