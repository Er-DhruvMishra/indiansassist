/**
 * The op implementations behind the gate (section 5.3): tab ops (tabs-control.ts), mirror ops, input replay in
 * `dom` or `debugger` mode (section 5.4), level / unmask / attach requests with a Desk prompt, and backstage.
 */
import {
  LIMITS,
  levelAtLeast,
  type ConsentLevel,
  type ControlEvent,
  type ControlRequest,
  type ControlResponse,
  type DeskEventAction,
  type InputKind,
  type InputMode,
  type MirrorScope,
} from '@indiansassist/shared';
import { ext } from '../shared/api';
import type { TabState } from '../shared/storage';
import { LEVEL_LABELS } from '../shared/ui-state';
import { cdpModifiers, cdpMouseEvents, type DebuggerControl } from './debugger-control';
import { ControlError, type GateContext } from './gate';
import type { EffectivePolicy } from './policy';
import type { PromptManager } from './prompts';
import { classifyUrl } from './tab-registry';
import { openBackstageTab, runTabOp, type TabsDeps } from './tabs-control';

export type ContentInputReply = { ok: true; cx?: number; cy?: number; applied?: boolean } | { ok: false; error: 'not_supported' | 'no_target'; message?: string };
export type UnmaskReply = { ok: true; fieldKind: string; label: string; outline: { w: number; h: number } } | { ok: false; cause: 'bad_target' | 'not_unmaskable' };

export interface ControlHost {
  /** True while Stop sharing / revoke / session end tears down: no op runs any more (F4). */
  readonly finishing?: boolean;
  sessionId(): string;
  technician(): string;
  gateContext(): GateContext;
  level(): ConsentLevel;
  scope(): MirrorScope;
  eff(): EffectivePolicy;
  tabState(tabId: number): TabState | undefined;
  tabsDeps: TabsDeps;
  send(msg: ControlResponse | ControlEvent): void;
  attest(action: DeskEventAction, data: Record<string, unknown>, reason?: string): void;
  recordInput(tabId: number, kind: InputKind, refused: boolean, mode?: InputMode): void;
  countTabAction(): void;
  listTabs(): Promise<Record<string, unknown>>;
  queryTabs(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  focus(tabId: number): Promise<void>;
  snapshot(tabId: number): Promise<void>;
  attachTab(tabId: number): Promise<void>;
  contentRequest<T>(tabId: number, msg: { t: string } & Record<string, unknown>): Promise<T | undefined>;
  readonly debuggerControl: DebuggerControl;
  inputMode(tabId: number): InputMode;
  setInputMode(tabId: number, mode: InputMode): void;
  readonly prompts: PromptManager;
  recording(): boolean;
  /** `desk.consent_level { requested: true, opId }`; resolves true after `consent.level_ok`. */
  requestLevel(level: ConsentLevel, opId: string): Promise<boolean>;
  revealGranted(tabId: number, scope: 'field' | 'tab', reason?: string, fieldKind?: string): void;
  backstageEntered(tabId: number, url: string, opId: string): void;
  backstageExit(tabId: number, action: 'close' | 'keep' | 'bring_to_front', opId: string): Promise<void>;
  /** `panelOnly`: the bar shows no Allow (a deep-control grant needs the side panel's permission prompt). */
  showBarPrompt(tabId: number | null, id: string, text: string, panelOnly?: boolean): void;
  clearBarPrompt(id: string): void;
}

const INPUT_KIND = { 'input.pointer': 'pointer', 'input.key': 'key', 'input.scroll': 'scroll', 'input.fill': 'fill' } as const;

function promptEvent(h: ControlHost, id: string, promptKind: 'level' | 'mask' | 'attach', state: 'shown' | 'answered', opId: string): void {
  h.send({ t: 'ctl.event', kind: 'prompt', id, promptKind, state, opId, ts: Date.now() });
}

async function input(req: ControlRequest, h: ControlHost): Promise<Record<string, unknown>> {
  const a = req.args as { tabId: number } & Record<string, unknown>;
  const mode = req.op === 'input.fill' ? 'dom' : h.inputMode(a.tabId);
  // Defence in depth (F2): CDP input only while the level is deep_control, whatever the per-tab mode says.
  if (mode === 'debugger' && !levelAtLeast(h.level(), 'deep_control')) throw new ControlError('not_allowed', 'requires deep_control');
  const reply = await h.contentRequest<ContentInputReply>(a.tabId, { t: 'cs.input', op: req.op, args: { ...a, mode } });
  const kind = INPUT_KIND[req.op as keyof typeof INPUT_KIND];
  if (!reply || !reply.ok) {
    h.recordInput(a.tabId, kind, true, mode);
    if (reply && !reply.ok && reply.error === 'not_supported') throw new ControlError('not_supported', reply.message ?? 'cross-origin frame');
    throw new ControlError('not_supported', 'the page did not accept the input');
  }
  if (mode === 'debugger') {
    try {
      await debuggerInput(req, h, reply.cx ?? 0, reply.cy ?? 0);
    } catch {
      h.recordInput(a.tabId, kind, true, mode);
      throw new ControlError('debugger_unavailable', 'deep control is not available on this tab');
    }
  }
  h.recordInput(a.tabId, kind, false, mode);
  return req.op === 'input.fill' ? { applied: reply.applied === true } : {};
}

async function debuggerInput(req: ControlRequest, h: ControlHost, x: number, y: number): Promise<void> {
  const d = h.debuggerControl;
  const a = req.args as Record<string, unknown> & { tabId: number; modifiers?: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } };
  const mods = a.modifiers ? cdpModifiers(a.modifiers) : 0;
  if (req.op === 'input.pointer') {
    const button = (a.button ?? 0) as 0 | 1 | 2;
    for (const ev of cdpMouseEvents(a.kind as 'move', x, y, button, mods, Number(a.deltaX ?? 0), Number(a.deltaY ?? 0))) await d.mouse(a.tabId, ev);
  } else if (req.op === 'input.scroll') {
    await d.mouse(a.tabId, { type: 'mouseWheel', x, y, modifiers: 0, button: 'none', deltaX: a.dx, deltaY: a.dy });
  } else if (req.op === 'input.key') {
    const base = { key: a.key, code: a.code, modifiers: mods };
    if (a.kind === 'press' && typeof a.text === 'string' && a.text.length > 0) await d.insertText(a.tabId, a.text);
    else if (a.kind === 'press') {
      await d.key(a.tabId, { ...base, type: 'keyDown' });
      await d.key(a.tabId, { ...base, type: 'keyUp' });
    } else await d.key(a.tabId, { ...base, type: a.kind === 'down' ? 'keyDown' : 'keyUp' });
  }
}

async function inputMode(req: Extract<ControlRequest, { op: 'input.mode' }>, h: ControlHost): Promise<Record<string, unknown>> {
  const { tabId, mode } = req.args;
  if (mode === 'debugger') {
    if (!(await h.debuggerControl.attach(tabId))) throw new ControlError('debugger_unavailable', 'deep control permission or attach failed');
  } else await h.debuggerControl.detach(tabId, 'request');
  h.setInputMode(tabId, mode);
  return { mode };
}

async function levelRequest(req: Extract<ControlRequest, { op: 'level.request' }>, opId: string, h: ControlHost): Promise<Record<string, unknown>> {
  const { level, reason } = req.args;
  const from = h.level();
  if (levelAtLeast(from, level)) return { level: from };
  if (!levelAtLeast(h.eff().maxLevel, level)) throw new ControlError('not_allowed', 'above the maximum level for this session');
  const pending = h.prompts.ask({
    id: req.id,
    promptKind: 'level',
    technician: h.technician(),
    reason: reason ?? null,
    label: LEVEL_LABELS[level],
    host: null,
    level,
    recording: h.recording(),
    recordRevealed: false,
  });
  if (!pending) throw new ControlError('rate_limited', 'another level request is open');
  promptEvent(h, req.id, 'level', 'shown', opId);
  h.showBarPrompt(null, req.id, `${h.technician()} asks for: ${LEVEL_LABELS[level].toLowerCase()}.${reason ? ` Reason: ${reason}` : ''}`, level === 'deep_control');
  const decision = await pending;
  h.clearBarPrompt(req.id);
  promptEvent(h, req.id, 'level', 'answered', opId);
  const refusedData = { from, requested: level, opId, timeout: decision === 'timeout' };
  if (decision !== 'allow') {
    h.attest('consent.level_refused', refusedData, reason);
    if (decision === 'timeout') throw new ControlError('timeout', 'no answer from the user');
    throw new ControlError('refused', decision === 'permission_refused' ? 'debugger permission refused' : 'the user refused');
  }
  if (!(await h.requestLevel(level, opId))) throw new ControlError('internal', 'the level change was not confirmed');
  return { level: h.level() };
}

async function maskRequest(req: Extract<ControlRequest, { op: 'mask.request' }>, opId: string, h: ControlHost): Promise<Record<string, unknown>> {
  const { tabId, scope, nodeId, reason } = req.args;
  const base = { tabId, scope, ...(nodeId !== undefined ? { nodeId } : {}), opId };
  if (!h.eff().allowUnmask) {
    h.attest('mask.refused', { ...base, cause: 'policy' }, reason);
    return { granted: false };
  }
  if (h.prompts.hasKind('mask')) throw new ControlError('rate_limited', 'another unmask request is open');
  const target = await h.contentRequest<UnmaskReply>(tabId, { t: 'cs.unmask', scope, nodeId: nodeId ?? null });
  if (!target || !target.ok) {
    h.attest('mask.refused', { ...base, cause: target && !target.ok ? target.cause : 'bad_target' }, reason);
    return { granted: false };
  }
  const fieldKind = scope === 'field' ? target.fieldKind : undefined;
  const st = h.tabState(tabId);
  const recordRevealed = h.eff().policy.recordRevealed;
  const pending = h.prompts.ask({
    id: req.id,
    promptKind: 'mask',
    technician: h.technician(),
    reason,
    label: target.label,
    host: st?.host ?? null,
    level: null,
    recording: h.recording(),
    recordRevealed,
  });
  if (!pending) throw new ControlError('rate_limited', 'another unmask request is open');
  promptEvent(h, req.id, 'mask', 'shown', opId);
  h.showBarPrompt(tabId, req.id, `${h.technician()} asks to see: ${target.label} on ${st?.host ?? 'this page'} for up to 60 seconds. Reason: ${reason}`);
  const decision = await pending;
  h.clearBarPrompt(req.id);
  promptEvent(h, req.id, 'mask', 'answered', opId);
  const kindPart = fieldKind ? { fieldKind } : {};
  if (decision !== 'allow') {
    await h.contentRequest(tabId, { t: 'cs.unmaskDecision', granted: false, ttlMs: 0 });
    h.attest('mask.refused', { ...base, ...kindPart, cause: decision === 'timeout' ? 'timeout' : 'refused' }, reason);
    return { granted: false };
  }
  const ttlMs = LIMITS.revealTtlMs;
  await h.contentRequest(tabId, { t: 'cs.unmaskDecision', granted: true, ttlMs });
  h.revealGranted(tabId, scope, reason, fieldKind);
  h.attest('mask.override', { ...base, ...kindPart, outline: target.outline, ttlMs }, reason);
  return { granted: true, ttlMs };
}

async function attach(req: Extract<ControlRequest, { op: 'mirror.attach' }>, opId: string, h: ControlHost): Promise<Record<string, unknown>> {
  const { tabId, reason } = req.args;
  const st = h.tabState(tabId);
  if (st && st.mirrored !== 'not_in_scope') return { attached: st.mirrored === 'yes' || st.mirrored === 'too_large' };
  const tab = await chromeTab(tabId);
  // prd-F9: a hidden tab that could never be shared (protected host, browser / file page) answers exactly like a
  // missing id, without a prompt, so sweeping tab ids cannot reveal that the Desk has a banking tab open.
  if (!tab || classifyUrl(tab.url ?? tab.pendingUrl, h.eff().denyList) !== 'ok') throw new ControlError('no_such_tab', 'no such tab');
  const pending = h.prompts.ask({
    id: req.id,
    promptKind: 'attach',
    technician: h.technician(),
    reason,
    label: (tab?.title ?? 'a tab').slice(0, 200),
    host: tab?.url ? safeHost(tab.url) : null,
    level: null,
    recording: h.recording(),
    recordRevealed: false,
  });
  if (!pending) throw new ControlError('rate_limited', 'another attach request is open');
  promptEvent(h, req.id, 'attach', 'shown', opId);
  const decision = await pending;
  promptEvent(h, req.id, 'attach', 'answered', opId);
  if (decision === 'timeout') throw new ControlError('timeout', 'no answer from the user');
  if (decision !== 'allow') throw new ControlError('refused', 'the user refused');
  await h.attachTab(tabId);
  return { attached: true };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

async function chromeTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await ext().tabs.get(tabId);
  } catch {
    return null;
  }
}

/** Executes a gated request; throws `ControlError` for every refusal or failure. */
export async function runControlOp(req: ControlRequest, opId: string, h: ControlHost): Promise<Record<string, unknown>> {
  switch (req.op) {
    case 'tabs.list':
      return h.listTabs();
    case 'tabs.query':
      return h.queryTabs(req.args);
    case 'mirror.focus':
      await h.focus(req.args.tabId);
      return {};
    case 'mirror.snapshot':
      await h.snapshot(req.args.tabId);
      return {};
    case 'mirror.attach':
      return attach(req, opId, h);
    case 'input.pointer':
    case 'input.key':
    case 'input.scroll':
    case 'input.fill':
      return input(req, h);
    case 'input.mode':
      return inputMode(req, h);
    case 'level.request':
      return levelRequest(req, opId, h);
    case 'mask.request':
      return maskRequest(req, opId, h);
    case 'backstage.enter': {
      const tab = await openBackstageTab(req.args.url, req.args.windowId, h.tabsDeps);
      h.backstageEntered(tab.id!, req.args.url, opId);
      return { tabId: tab.id };
    }
    case 'backstage.exit': {
      if (!h.tabState(req.args.tabId)?.backstage) throw new ControlError('bad_args', 'not a background tab');
      await h.backstageExit(req.args.tabId, req.args.action, opId);
      return {};
    }
    default:
      return runTabOp(req.op, req.args as Record<string, unknown>, h.tabsDeps);
  }
}
