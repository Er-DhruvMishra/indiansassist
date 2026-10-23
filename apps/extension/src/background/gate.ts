/**
 * The extension-side consent gate (sections 5.2, 6 B1/B4, 8.3): every `ctl.req` is evaluated against the current
 * level, the backstage consent and policy, and the target tab's state before anything executes. The server cannot
 * see the data channel, so this is where control above the granted level is refused.
 */
import { CONSENT_LEVEL_ORDER, minLevelFor, type ConsentLevel, type ControlErrorCode, type ControlRequest } from '@indiansassist/shared';
import type { TabState } from '../shared/storage';

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export type GateContext = {
  level: ConsentLevel;
  backstageConsent: boolean;
  backstageAllowed: boolean;
  tab: (tabId: number) => TabState | undefined;
};

/** Ops that read or change a tab's content or navigation (denied => `denied_url`). */
const CONTENT_OPS = new Set([
  'tabs.reload',
  'tabs.navigate',
  'input.pointer',
  'input.key',
  'input.scroll',
  'input.fill',
  'input.mode',
  'mirror.focus',
  'mirror.snapshot',
  'mask.request',
]);
/** Ops refused on a paused tab (section 8.3). */
const PAUSE_BLOCKED = new Set(['tabs.reload', 'tabs.navigate', 'input.pointer', 'input.key', 'input.scroll', 'input.fill', 'input.mode']);
/** Ops whose target must have mirrored content (unsupported / too large tabs answer `not_supported`). */
const NEEDS_DOCUMENT = new Set(['input.pointer', 'input.key', 'input.scroll', 'input.fill', 'input.mode', 'mask.request', 'mirror.snapshot']);

function levelOk(current: ConsentLevel, needed: ConsentLevel): boolean {
  return CONSENT_LEVEL_ORDER[current] >= CONSENT_LEVEL_ORDER[needed];
}

function checkTab(op: string, tabId: number, ctx: GateContext): ControlError | null {
  const st = ctx.tab(tabId);
  if (!st) return new ControlError('no_such_tab', 'no such tab');
  if (op === 'mirror.attach') {
    if (st.mirrored === 'denied') return new ControlError('denied_url', 'this tab is on a protected site');
    if (st.mirrored === 'unsupported') return new ControlError('not_supported', 'this tab cannot be shared');
    return null;
  }
  if (st.mirrored === 'not_in_scope') return new ControlError('not_in_scope', 'this tab is not shared');
  if (CONTENT_OPS.has(op) && st.mirrored === 'denied') return new ControlError('denied_url', 'this tab is on a protected site');
  if (PAUSE_BLOCKED.has(op) && st.paused) return new ControlError('tab_paused', 'the user paused this tab');
  if (NEEDS_DOCUMENT.has(op) && (st.mirrored === 'unsupported' || st.mirrored === 'too_large'))
    return new ControlError('not_supported', 'this tab cannot be controlled');
  if (op === 'tabs.activate' && st.backstage) return new ControlError('not_allowed', 'use bring to front for a background tab');
  return null;
}

/** Null when the op may run; the refusal otherwise. URL checks (`assertNavigableUrl`) run in the op itself. */
export function gateOp(req: ControlRequest, ctx: GateContext): ControlError | null {
  const needed = minLevelFor(req.op, req.args);
  if (!levelOk(ctx.level, needed)) return new ControlError('not_allowed', `requires ${needed}`);
  if (req.op === 'backstage.enter') {
    if (!ctx.backstageAllowed) return new ControlError('not_allowed', 'background tabs not allowed by policy');
    if (!ctx.backstageConsent) return new ControlError('not_allowed', 'background tabs not allowed by the user');
  }
  const args = req.args as { tabId?: number; tabIds?: number[] };
  if (typeof args.tabId === 'number') {
    const err = checkTab(req.op, args.tabId, ctx);
    if (err) return err;
  }
  if (Array.isArray(args.tabIds)) {
    for (const id of args.tabIds) {
      const st = ctx.tab(id);
      if (!st) return new ControlError('no_such_tab', `no such tab ${id}`);
      if (st.mirrored === 'not_in_scope') return new ControlError('not_in_scope', `tab ${id} is not shared`);
    }
  }
  return null;
}
