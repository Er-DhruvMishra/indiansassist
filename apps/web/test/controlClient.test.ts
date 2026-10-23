/**
 * Control message builders and the `ctl.req` client (Phase B 3.7, 5): op args from replayer captures, consent
 * gating of the input modes, URL checks, console reports, ids / opId, timeouts, coalescing, relay fallback,
 * de-duplication and report retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, controlRequestSchema, opIdFor, type ControlRequest } from '@indiansassist/shared';
import { ControlClient, type AnyReport } from '../src/assist/console/mirror/controlClient';
import {
  clampMode,
  forwardsInput,
  keyArgs,
  normaliseNavUrl,
  pointerArgs,
  reportFor,
  scrollArgs,
  segmentState,
} from '../src/assist/console/mirror/controlBuilders';
import { IDS } from './fakes';

const mods = { alt: false, ctrl: false, meta: false, shift: false };

describe('control message builders', () => {
  it('builds input.pointer args with rounded coordinates and nx/ny only for a known node', () => {
    const a = pointerArgs(7, { t: 'rp.pointer', tabId: 7, kind: 'click', nodeId: 42, nx: 0.123456, ny: 0.98765, vx: 0.333333, vy: 0.5, button: 0, modifiers: mods });
    expect(a).toEqual({ tabId: 7, kind: 'click', nodeId: 42, nx: 0.1235, ny: 0.9877, vx: 0.3333, vy: 0.5, modifiers: mods });
    expect(controlRequestSchema.safeParse({ t: 'ctl.req', id: 'r1', op: 'input.pointer', args: a, ts: 1 }).success).toBe(true);
    const unknown = pointerArgs(7, { t: 'rp.pointer', tabId: 7, kind: 'contextmenu', nodeId: null, nx: 0.2, ny: 0.2, vx: 1, vy: 0, button: 2, modifiers: mods });
    expect(unknown).toEqual({ tabId: 7, kind: 'contextmenu', nodeId: null, vx: 1, vy: 0, button: 2, modifiers: mods });
  });

  it('turns a printable key-down into one press with text and drops its key-up', () => {
    expect(keyArgs(3, { t: 'rp.key', tabId: 3, kind: 'down', key: 'a', code: 'KeyA', modifiers: mods })).toEqual({ tabId: 3, kind: 'press', key: 'a', code: 'KeyA', modifiers: mods, text: 'a' });
    expect(keyArgs(3, { t: 'rp.key', tabId: 3, kind: 'up', key: 'a', code: 'KeyA', modifiers: mods })).toBeNull();
    expect(keyArgs(3, { t: 'rp.key', tabId: 3, kind: 'down', key: 'Enter', code: 'Enter', modifiers: mods })).toEqual({ tabId: 3, kind: 'down', key: 'Enter', code: 'Enter', modifiers: mods });
    const ctrlC = keyArgs(3, { t: 'rp.key', tabId: 3, kind: 'down', key: 'c', code: 'KeyC', modifiers: { ...mods, ctrl: true } });
    expect(ctrlC).toMatchObject({ kind: 'down', key: 'c' });
    expect(scrollArgs(3, { t: 'rp.wheel', tabId: 3, nodeId: null, vx: 0, vy: 0, deltaX: 0.4, deltaY: 120.6 })).toEqual({ tabId: 3, nodeId: null, dx: 0, dy: 121 });
  });

  it('accepts only http(s) navigation targets', () => {
    expect(normaliseNavUrl('example.com/path')).toBe('https://example.com/path');
    expect(normaliseNavUrl(' http://intranet.local:8080/x ')).toBe('http://intranet.local:8080/x');
    for (const bad of ['javascript:alert(1)', 'chrome://settings', 'file:///C:/x', 'data:text/html,x', 'view-source:https://a.com', '']) expect(normaliseNavUrl(bad)).toBeNull();
  });

  it('greys input modes above the granted level and blocks those above the org maximum', () => {
    expect(segmentState('view', 'view', 'tab_control')).toBe('selected');
    expect(segmentState('tab', 'view', 'tab_control')).toBe('available');
    expect(segmentState('in_page', 'view', 'tab_control')).toBe('ask');
    expect(segmentState('deep', 'view', 'tab_control', 'in_page')).toBe('blocked');
    expect(segmentState('tab', 'view', null)).toBe('ask');
    expect(clampMode('deep', 'in_page')).toBe('in_page');
    expect(clampMode('in_page', 'view')).toBe('view');
    expect(forwardsInput('in_page', 'in_page')).toBe(true);
    expect(forwardsInput('in_page', 'tab_control')).toBe(false);
    expect(forwardsInput('tab', 'deep_control')).toBe(false);
  });

  it('builds the console reports of section 3.7 (host on the wire, never a hash)', () => {
    expect(reportFor('tabs.navigate', { tabId: 4, url: 'https://Mail.Example.com/inbox?q=1' }, 'abcdef0123456789')).toEqual({ action: 'tab.action', data: { kind: 'tabs.navigate', opId: 'abcdef0123456789', tabId: 4, host: 'mail.example.com' } });
    expect(reportFor('tabs.close', { tabIds: [1, 2, 3] }, 'o')).toEqual({ action: 'tab.action', data: { kind: 'tabs.close', opId: 'o', tabIds: [1, 2, 3] } });
    expect(reportFor('backstage.enter', { url: 'https://a.example/x' }, 'o')).toEqual({ action: 'backstage.enter', data: { host: 'a.example', opId: 'o' } });
    expect(reportFor('mask.request', { tabId: 2, scope: 'field', nodeId: 9, reason: 'check the address' }, 'o')).toEqual({ action: 'mask.requested', data: { tabId: 2, scope: 'field', nodeId: 9, opId: 'o' }, reason: 'check the address' });
    expect(reportFor('level.request', { level: 'in_page', reason: 'fix settings' }, 'o')).toEqual({ action: 'level.requested', data: { level: 'in_page', opId: 'o' }, reason: 'fix settings' });
    expect(reportFor('tabs.list', {}, 'o')).toBeNull();
    expect(reportFor('mirror.focus', { tabId: 1 }, 'o')).toBeNull();
  });
});

describe('ControlClient', () => {
  let sentDc: ControlRequest[];
  let sentRelay: ControlRequest[];
  let reports: AnyReport[];
  let dcOpen: boolean;
  let n: number;
  let client: ControlClient;
  let report: ReturnType<typeof vi.fn<(r: AnyReport) => Promise<void>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    sentDc = [];
    sentRelay = [];
    reports = [];
    dcOpen = true;
    n = 0;
    report = vi.fn<(r: AnyReport) => Promise<void>>(async (r) => void reports.push(r));
    client = new ControlClient({
      sessionId: IDS.session,
      sendDc: (m) => dcOpen && sentDc.push(m) > 0,
      sendRelay: (m) => sentRelay.push(m) > 0,
      report,
      newId: () => `req-${++n}`,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  it('sends a validated ctl.req, reports it with the opId at send time, and resolves on its ctl.res', async () => {
    const p = client.request('tabs.reload', { tabId: 5 });
    expect(sentDc).toEqual([{ t: 'ctl.req', id: 'req-1', op: 'tabs.reload', args: { tabId: 5 }, ts: expect.any(Number) }]);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toEqual({ action: 'tab.action', data: { kind: 'tabs.reload', opId: opIdFor(IDS.session, 'req-1'), tabId: 5 } });
    expect(client.opIdOf('req-1')).toMatch(/^[0-9a-f]{16}$/);
    client.handle({ t: 'ctl.res', id: 'req-1', ok: true, result: {}, ts: 2 });
    client.handle({ t: 'ctl.res', id: 'req-1', ok: false, error: { code: 'internal', message: 'dup' }, ts: 3 });
    await expect(p).resolves.toEqual({ ok: true, result: {} });
  });

  it('refuses invalid args locally without sending anything', async () => {
    await expect(client.request('tabs.navigate', { tabId: 1, url: 'chrome://settings' })).resolves.toMatchObject({ ok: false, code: 'bad_args' });
    await expect(client.request('level.request', { level: 'in_page' })).resolves.toMatchObject({ ok: false, code: 'bad_args' });
    expect(sentDc).toEqual([]);
  });

  it('times out after 10 s, and after 65 s for prompt ops', async () => {
    const quick = client.request('tabs.pin', { tabId: 1, pinned: true });
    const prompt = client.request('level.request', { level: 'in_page', reason: 'need to click' });
    vi.advanceTimersByTime(LIMITS.controlRequestTimeoutMs);
    await expect(quick).resolves.toMatchObject({ ok: false, code: 'timeout' });
    expect(client.pendingCount).toBe(1);
    vi.advanceTimersByTime(LIMITS.promptRequestTimeoutMs - LIMITS.controlRequestTimeoutMs);
    await expect(prompt).resolves.toMatchObject({ ok: false, code: 'timeout' });
  });

  it('falls back to control.relay while ia.control is closed', () => {
    dcOpen = false;
    void client.request('tabs.list', {});
    expect(sentDc).toEqual([]);
    expect(sentRelay).toHaveLength(1);
    expect(client.viaRelay).toBe(true);
  });

  it('coalesces pointer moves to 30 / s keeping the newest, and drops moves while one is stalled', () => {
    const mv = (vx: number) => ({ tabId: 1, kind: 'move' as const, nodeId: null, vx, vy: 0.5, modifiers: mods });
    client.pointer(mv(0.1));
    client.pointer(mv(0.2));
    client.pointer(mv(0.3));
    expect(sentDc.map((m) => (m.args as { vx: number }).vx)).toEqual([0.1]);
    vi.advanceTimersByTime(40);
    expect(sentDc.map((m) => (m.args as { vx: number }).vx)).toEqual([0.1, 0.3]);
    vi.advanceTimersByTime(400); // both moves unanswered > 300 ms
    client.pointer(mv(0.9));
    expect(sentDc).toHaveLength(2);
    client.handle({ t: 'ctl.res', id: 'req-1', ok: true, result: {}, ts: 1 });
    client.handle({ t: 'ctl.res', id: 'req-2', ok: true, result: {}, ts: 1 });
    client.pointer(mv(0.8));
    expect(sentDc).toHaveLength(3);
  });

  it('aggregates control.input per tab and mode over 10 s', async () => {
    client.pointer({ tabId: 2, kind: 'click', nodeId: 5, nx: 0.5, ny: 0.5, vx: 0.5, vy: 0.5, modifiers: mods });
    void client.key({ tabId: 2, kind: 'press', key: 'x', code: 'KeyX', modifiers: mods, text: 'x' });
    expect(reports).toEqual([]);
    vi.advanceTimersByTime(LIMITS.controlInputAggregateMs);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toEqual({ action: 'control.input', data: { mode: 'dom', tabId: 2, count: 2, kinds: ['pointer', 'key'], windowMs: LIMITS.controlInputAggregateMs } });
  });

  it('drops wrong-direction and duplicate events, and switches the input mode on ctl.event debugger', () => {
    const seen = vi.fn();
    const c = new ControlClient({ sessionId: IDS.session, sendDc: () => true, report: async () => undefined, onEvent: seen });
    c.handle({ t: 'ctl.req', id: 'x', op: 'tabs.list', args: {}, ts: 1 });
    c.handle({ t: 'ctl.event', kind: 'debugger', tabId: 3, attached: true, ts: 10 });
    c.handle({ t: 'ctl.event', kind: 'debugger', tabId: 3, attached: true, ts: 10 });
    c.handle({ t: 'ctl.event', kind: 'bogus', ts: 11 });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(c.inputMode).toBe('debugger');
    c.dispose();
  });

  it('retries a failed report 3 times, then counts it as not reported without blocking the op', async () => {
    report.mockRejectedValue(new Error('offline'));
    const p = client.request('tabs.mute', { tabId: 1, muted: true });
    expect(sentDc).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500 + 1000 + 10);
    expect(report).toHaveBeenCalledTimes(3);
    expect(client.unreported).toBe(1);
    client.handle({ t: 'ctl.res', id: 'req-1', ok: true, result: {}, ts: 1 });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it('applies the client-side general bucket (burst 60)', async () => {
    const results = await Promise.all(Array.from({ length: 61 }, () => client.request('tabs.list', {}).then((r) => r)).map((p, i) => (i < 60 ? Promise.resolve(null) : p)));
    expect(sentDc).toHaveLength(60);
    expect(results[60]).toMatchObject({ ok: false, code: 'rate_limited' });
  });
});
