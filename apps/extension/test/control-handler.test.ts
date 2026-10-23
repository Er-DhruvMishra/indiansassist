import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXTENSION_POLICY, opIdFor, type ConsentLevel, type ControlResponse } from '@indiansassist/shared';
import { ControlHandler } from '../src/background/control-handler';
import type { ControlHost } from '../src/background/control-ops';
import { DebuggerControl } from '../src/background/debugger-control';
import { effectivePolicy } from '../src/background/policy';
import { PromptManager } from '../src/background/prompts';
import type { TabState } from '../src/shared/storage';
import { installChromeMock, makeTab } from './chrome-mock';

const SID = '00000000-0000-4000-8000-000000000010';
const mods = { alt: false, ctrl: false, meta: false, shift: false };

function host(level: ConsentLevel, tabs: Record<number, TabState>) {
  const sent: ControlResponse[] = [];
  const attested: { action: string; data: Record<string, unknown>; reason?: string }[] = [];
  const inputs: unknown[] = [];
  const prompts = new PromptManager(() => undefined);
  const contentRequest = vi.fn(async (_tab: number, msg: { t: string }) => (msg.t === 'cs.input' ? { ok: true, cx: 5, cy: 6 } : undefined) as never);
  const h = {
    sessionId: () => SID,
    technician: () => 'Asha',
    level: () => level,
    scope: () => 'all_tabs',
    eff: () => effectivePolicy(DEFAULT_EXTENSION_POLICY),
    gateContext: () => ({ level, backstageConsent: false, backstageAllowed: true, tab: (id: number) => tabs[id] }),
    tabState: (id: number) => tabs[id],
    tabsDeps: { denyList: () => [], info: () => null, onCreated: vi.fn() },
    send: (m: ControlResponse) => void sent.push(m),
    attest: (action: string, data: Record<string, unknown>, reason?: string) => void attested.push({ action, data, reason }),
    recordInput: (...a: unknown[]) => void inputs.push(a),
    countTabAction: vi.fn(),
    listTabs: vi.fn(async () => ({ tabs: [], hiddenCount: 0, activeTabId: null, focusedTabId: null })),
    queryTabs: vi.fn(async () => ({ tabs: [], hiddenCount: 0 })),
    focus: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => undefined),
    attachTab: vi.fn(async () => undefined),
    contentRequest,
    debuggerControl: new DebuggerControl(() => undefined),
    inputMode: () => 'dom',
    setInputMode: vi.fn(),
    prompts,
    recording: () => false,
    requestLevel: vi.fn(async () => true),
    revealGranted: vi.fn(),
    backstageEntered: vi.fn(),
    backstageExit: vi.fn(async () => undefined),
    showBarPrompt: vi.fn(),
    clearBarPrompt: vi.fn(),
  } as unknown as ControlHost;
  return { h, sent, attested, inputs, prompts, contentRequest };
}

const st = (p: Partial<TabState> = {}): TabState => ({ mirrored: 'yes', paused: false, inScope: true, backstage: false, createdByAssist: false, enteredAt: 0, injected: true, host: 'example.com', ...p });

beforeEach(() => {
  installChromeMock({ tabs: [makeTab(1, 'https://example.com/')] });
});

describe('control handler (sections 4.6, 5)', () => {
  it('answers every request exactly once and attests refused tab ops with the opId', async () => {
    const t = host('view', { 1: st() });
    const c = new ControlHandler(t.h);
    await c.handle({ t: 'ctl.req', id: 'a1', op: 'tabs.pin', args: { tabId: 1, pinned: true }, ts: 1 });
    expect(t.sent).toEqual([expect.objectContaining({ t: 'ctl.res', id: 'a1', ok: false, error: { code: 'not_allowed', message: 'requires tab_control' } })]);
    expect(t.attested).toEqual([{ action: 'tab.action', data: { kind: 'tabs.pin', opId: opIdFor(SID, 'a1'), tabId: 1, ok: false, error: 'not_allowed' }, reason: undefined }]);
  });

  it('input above the level is refused and counted as refused input; at in_page it reaches the page', async () => {
    const low = host('tab_control', { 1: st() });
    await new ControlHandler(low.h).handle({ t: 'ctl.req', id: 'p1', op: 'input.pointer', args: { tabId: 1, kind: 'click', nodeId: null, vx: 0.1, vy: 0.2, modifiers: mods }, ts: 1 });
    expect(low.sent[0]).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(low.contentRequest).not.toHaveBeenCalled();
    expect(low.inputs).toEqual([[1, 'pointer', true]]);
    const ok = host('in_page', { 1: st() });
    await new ControlHandler(ok.h).handle({ t: 'ctl.req', id: 'p2', op: 'input.pointer', args: { tabId: 1, kind: 'click', nodeId: null, vx: 0.1, vy: 0.2, modifiers: mods }, ts: 1 });
    expect(ok.sent[0]).toMatchObject({ ok: true });
    expect(ok.contentRequest).toHaveBeenCalledWith(1, expect.objectContaining({ t: 'cs.input', op: 'input.pointer' }));
  });

  it('bad args answer bad_args (attested for tab ops); unknown ops answer not_supported', async () => {
    const t = host('deep_control', { 1: st() });
    const c = new ControlHandler(t.h);
    await c.handle({ t: 'ctl.req', id: 'b1', op: 'tabs.create', args: { url: 'chrome://settings' }, ts: 1 });
    await c.handle({ t: 'ctl.req', id: 'b2', op: 'tabs.explode', args: {}, ts: 1 });
    await c.handle({ t: 'ctl.req', id: 'b3', op: 'level.request', args: { level: 'in_page' }, ts: 1 });
    expect(t.sent.map((s) => (s.ok ? 'ok' : s.error.code))).toEqual(['bad_args', 'not_supported', 'bad_args']);
    expect(t.attested.map((a) => [a.action, a.data.error])).toEqual([['tab.action', 'bad_args']]);
  });

  it('drops wrong-direction messages and duplicate ids; rate-limits above the bucket', async () => {
    const t = host('tab_control', { 1: st() });
    const c = new ControlHandler(t.h, () => 0);
    await c.handle({ t: 'ctl.res', id: 'x', ok: true, result: {}, ts: 1 });
    await c.handle({ t: 'ctl.event', kind: 'paused', tabId: 1, paused: true, ts: 1 });
    expect(t.sent).toHaveLength(0);
    await c.handle({ t: 'ctl.req', id: 'd1', op: 'tabs.list', args: {}, ts: 1 });
    await c.handle({ t: 'ctl.req', id: 'd1', op: 'tabs.list', args: {}, ts: 1 });
    expect(t.sent).toHaveLength(1);
    for (let i = 0; i < 70; i++) await c.handle({ t: 'ctl.req', id: `r${i}`, op: 'tabs.list', args: {}, ts: 1 });
    expect(t.sent.filter((s) => !s.ok && s.error.code === 'rate_limited').length).toBeGreaterThan(0);
  });

  it('level.request prompts the Desk; Refuse writes consent.level_refused with the reason', async () => {
    const t = host('tab_control', { 1: st() });
    const c = new ControlHandler(t.h);
    const done = c.handle({ t: 'ctl.req', id: 'l1', op: 'level.request', args: { level: 'in_page', reason: 'to fix the form' }, ts: 1 });
    await Promise.resolve();
    expect(t.prompts.list()).toHaveLength(1);
    expect(t.prompts.list()[0]).toMatchObject({ promptKind: 'level', reason: 'to fix the form', level: 'in_page' });
    t.prompts.answer('l1', 'refuse');
    await done;
    expect(t.sent.at(-1)).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(t.attested.at(-1)).toEqual({ action: 'consent.level_refused', data: { from: 'tab_control', requested: 'in_page', opId: opIdFor(SID, 'l1'), timeout: false }, reason: 'to fix the form' });
  });

  it('level.request Allow sends desk.consent_level and answers after the server confirmed', async () => {
    const t = host('tab_control', { 1: st() });
    const c = new ControlHandler(t.h);
    const done = c.handle({ t: 'ctl.req', id: 'l2', op: 'level.request', args: { level: 'in_page', reason: 'x' }, ts: 1 });
    await Promise.resolve();
    t.prompts.answer('l2', 'allow');
    await done;
    expect(t.h.requestLevel).toHaveBeenCalledWith('in_page', opIdFor(SID, 'l2'));
    expect(t.sent.at(-1)).toMatchObject({ ok: true });
    const events = (t.sent as unknown as { t: string; kind?: string; state?: string }[]).filter((m) => m.t === 'ctl.event');
    expect(events.map((e) => e.state)).toEqual(['shown', 'answered']);
  });

  it('mask.request on a secret answers granted false without a prompt (not_unmaskable)', async () => {
    const t = host('view', { 1: st() });
    (t.contentRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, cause: 'not_unmaskable' });
    await new ControlHandler(t.h).handle({ t: 'ctl.req', id: 'm1', op: 'mask.request', args: { tabId: 1, scope: 'field', nodeId: 9, reason: 'check' }, ts: 1 });
    expect(t.sent[0]).toMatchObject({ ok: true, result: { granted: false } });
    expect(t.prompts.list()).toHaveLength(0);
    expect(t.attested[0]).toMatchObject({ action: 'mask.refused', data: { cause: 'not_unmaskable', nodeId: 9 }, reason: 'check' });
  });
});
