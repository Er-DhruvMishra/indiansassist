/**
 * Pure builders for the console side of the control protocol (Phase B 5.3, 5.4, 10.1): input modes and their
 * consent gating, replayer captures -> `input.*` args, URL checks before a navigation op, and the console's audit
 * report for each request (section 3.7). No I/O here; `controlClient` sends what these return.
 */
import {
  CONSENT_LEVELS,
  TAB_ACTION_KINDS,
  hostOf,
  isMirrorableUrl,
  levelAtLeast,
  roundCoord,
  type ConsentLevel,
  type ControlOp,
  type TabActionKind,
} from '@indiansassist/shared';
import type { RpKey, RpPointer, RpWheel } from './replayerProtocol';

/** The four segments of the input mode toggle, one per consent level (section 10.1). */
export type InputMode = 'view' | 'tab' | 'in_page' | 'deep';
export const INPUT_MODES_UI: readonly InputMode[] = ['view', 'tab', 'in_page', 'deep'];
export const MODE_LEVEL: Record<InputMode, ConsentLevel> = { view: 'view', tab: 'tab_control', in_page: 'in_page', deep: 'deep_control' };
export const MODE_LABEL: Record<InputMode, string> = { view: 'View', tab: 'Tab control', in_page: 'In-page', deep: 'Deep control' };
export const LEVEL_LABEL: Record<ConsentLevel, string> = {
  view: 'View only',
  tab_control: 'Switch and open tabs',
  in_page: 'Click and type in shared pages',
  deep_control: 'Deep control',
};

export type SegmentState = 'selected' | 'available' | 'ask' | 'blocked';

/**
 * A segment is usable when the Desk granted its level (`consent.changed.level`, never the op reply alone);
 * above that it reads "Ask the user"; above the org's maximum it cannot be asked for at all.
 */
export function segmentState(mode: InputMode, selected: InputMode, granted: ConsentLevel | null, max: ConsentLevel = 'deep_control'): SegmentState {
  const need = MODE_LEVEL[mode];
  if (!levelAtLeast(max, need)) return 'blocked';
  if (!granted || !levelAtLeast(granted, need)) return 'ask';
  return mode === selected ? 'selected' : 'available';
}

/** The highest mode the granted level allows (used to step the selection down when the Desk lowers the level). */
export function clampMode(selected: InputMode, granted: ConsentLevel | null): InputMode {
  if (!granted) return 'view';
  let out: InputMode = 'view';
  for (const m of INPUT_MODES_UI) if (levelAtLeast(granted, MODE_LEVEL[m]) && levelAtLeast(MODE_LEVEL[selected], MODE_LEVEL[m])) out = m;
  return out;
}

/** True when the op may be offered at the granted level (buttons below it are disabled with a tooltip). */
export function opAllowed(op: ControlOp, granted: ConsentLevel | null, minLevel: (op: ControlOp) => ConsentLevel): boolean {
  return granted !== null && levelAtLeast(granted, minLevel(op));
}

/** Pointer and key capture is forwarded only in the in-page and deep modes. */
export function forwardsInput(mode: InputMode, granted: ConsentLevel | null): boolean {
  return (mode === 'in_page' || mode === 'deep') && granted !== null && levelAtLeast(granted, MODE_LEVEL[mode]);
}

export const isConsentLevel = (x: unknown): x is ConsentLevel => typeof x === 'string' && (CONSENT_LEVELS as readonly string[]).includes(x);

// ---------- replayer capture -> op args ----------

export type PointerArgs = {
  tabId: number;
  kind: RpPointer['kind'] | 'wheel';
  nodeId: number | null;
  nx?: number;
  ny?: number;
  vx: number;
  vy: number;
  button?: 0 | 1 | 2;
  modifiers: RpPointer['modifiers'];
  deltaX?: number;
  deltaY?: number;
};

/** `input.pointer` args: coordinates rounded to 4 decimals; `nx`/`ny` only when the node is known (section 5.3). */
export function pointerArgs(tabId: number, p: RpPointer): PointerArgs {
  const out: PointerArgs = { tabId, kind: p.kind, nodeId: p.nodeId, vx: roundCoord(p.vx), vy: roundCoord(p.vy), modifiers: p.modifiers };
  if (p.nodeId !== null && p.nx !== undefined && p.ny !== undefined) {
    out.nx = roundCoord(p.nx);
    out.ny = roundCoord(p.ny);
  } else {
    out.nodeId = null;
  }
  if (p.button !== 0) out.button = p.button;
  return out;
}

/** `input.scroll` args from a wheel capture (CSS px deltas). */
export function scrollArgs(tabId: number, w: RpWheel): { tabId: number; nodeId: number | null; dx: number; dy: number } {
  return { tabId, nodeId: w.nodeId, dx: Math.round(w.deltaX), dy: Math.round(w.deltaY) };
}

export type KeyArgs = { tabId: number; kind: 'down' | 'up' | 'press'; key: string; code: string; modifiers: RpKey['modifiers']; text?: string };

/**
 * `input.key` args. A printable key without Ctrl/Meta becomes one `press` carrying `text` (the extension inserts it
 * so frameworks see the change); its key-up is then redundant and returns null. Everything else passes through.
 */
export function keyArgs(tabId: number, k: RpKey): KeyArgs | null {
  const printable = k.key.length === 1 && !k.modifiers.ctrl && !k.modifiers.meta;
  if (printable) return k.kind === 'down' ? { tabId, kind: 'press', key: k.key, code: k.code, modifiers: k.modifiers, text: k.key } : null;
  return { tabId, kind: k.kind, key: k.key, code: k.code, modifiers: k.modifiers };
}

// ---------- URLs ----------

/** Client-side check before `tabs.create`/`tabs.navigate`/`backstage.enter`: `http(s)` only; bare hosts get https. */
export function normaliseNavUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return isMirrorableUrl(u.href) && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

// ---------- console audit reports (section 3.7) ----------

export type ConsoleReport = { action: 'tab.action' | 'backstage.enter' | 'backstage.exit' | 'mask.requested' | 'level.requested'; data: Record<string, unknown>; reason?: string };

const isTabAction = (op: string): op is TabActionKind => (TAB_ACTION_KINDS as readonly string[]).includes(op);

/** The report the console posts when it sends `op` (null for ops with no audit, and for `input.*`, which aggregate). */
export function reportFor(op: ControlOp, args: Record<string, unknown>, opId: string): ConsoleReport | null {
  if (isTabAction(op)) {
    const data: Record<string, unknown> = { kind: op, opId };
    if (typeof args.tabId === 'number') data.tabId = args.tabId;
    if (Array.isArray(args.tabIds)) data.tabIds = args.tabIds;
    if ((op === 'tabs.create' || op === 'tabs.navigate') && typeof args.url === 'string') {
      const h = hostOf(args.url);
      if (h) data.host = h;
    }
    return { action: 'tab.action', data };
  }
  if (op === 'backstage.enter') {
    const h = typeof args.url === 'string' ? hostOf(args.url) : null;
    return h ? { action: 'backstage.enter', data: { host: h, opId } } : null;
  }
  if (op === 'backstage.exit') return { action: 'backstage.exit', data: { tabId: args.tabId, action: args.action, opId } };
  if (op === 'mask.request') {
    const data: Record<string, unknown> = { tabId: args.tabId, scope: args.scope, opId };
    if (typeof args.nodeId === 'number') data.nodeId = args.nodeId;
    return { action: 'mask.requested', data, reason: String(args.reason ?? '') };
  }
  if (op === 'level.request') {
    const r: ConsoleReport = { action: 'level.requested', data: { level: args.level, opId } };
    if (typeof args.reason === 'string') r.reason = args.reason;
    return r;
  }
  return null;
}

/** Which `control.input.kinds` entry an input op counts as. */
export function inputKind(op: ControlOp): 'pointer' | 'key' | 'scroll' | 'fill' | null {
  if (op === 'input.pointer') return 'pointer';
  if (op === 'input.key') return 'key';
  if (op === 'input.scroll') return 'scroll';
  if (op === 'input.fill') return 'fill';
  return null;
}
