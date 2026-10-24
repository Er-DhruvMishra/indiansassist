import { describe, expect, it, vi } from 'vitest';
import { controlRequestSchema, type ConsentLevel, type ControlRequest } from '@indiansassist/shared';
import { gateOp, type GateContext } from '../src/background/gate';
import type { TabState } from '../src/shared/storage';

function st(p: Partial<TabState> = {}): TabState {
  return { mirrored: 'yes', paused: false, inScope: true, backstage: false, createdByAssist: false, enteredAt: 0, injected: true, host: 'example.com', ...p };
}

function req(op: string, args: Record<string, unknown>): ControlRequest {
  return controlRequestSchema.parse({ t: 'ctl.req', id: 'r1', op, args, ts: 1 }) as ControlRequest;
}

function ctx(level: ConsentLevel, tabs: Record<number, TabState> = { 1: st() }, extra: Partial<GateContext> = {}): GateContext {
  return { level, backstageConsent: false, backstageAllowed: true, tab: (id) => tabs[id], ...extra };
}

const pointer = { tabId: 1, kind: 'click', nodeId: null, vx: 0.5, vy: 0.5, modifiers: { alt: false, ctrl: false, meta: false, shift: false } };

describe('consent-level gate (section 5.2)', () => {
  it('refuses every op above the granted level with not_allowed', () => {
    expect(gateOp(req('tabs.activate', { tabId: 1 }), ctx('view'))?.code).toBe('not_allowed');
    expect(gateOp(req('tabs.close', { tabIds: [1] }), ctx('view'))?.code).toBe('not_allowed');
    expect(gateOp(req('input.pointer', pointer), ctx('tab_control'))?.code).toBe('not_allowed');
    expect(gateOp(req('input.fill', { tabId: 1, nodeId: 3, value: 'x', commit: true }), ctx('tab_control'))?.code).toBe('not_allowed');
    expect(gateOp(req('input.mode', { tabId: 1, mode: 'debugger' }), ctx('in_page'))?.code).toBe('not_allowed');
    expect(gateOp(req('input.mode', { tabId: 1, mode: 'dom' }), ctx('in_page'))).toBeNull();
    expect(gateOp(req('tabs.list', {}), ctx('view'))).toBeNull();
    expect(gateOp(req('input.pointer', pointer), ctx('in_page'))).toBeNull();
    expect(gateOp(req('input.mode', { tabId: 1, mode: 'debugger' }), ctx('deep_control'))).toBeNull();
  });

  it('backstage needs the policy and the Desk consent', () => {
    const r = req('backstage.enter', { url: 'https://example.com/' });
    expect(gateOp(r, ctx('tab_control'))?.message).toBe('background tabs not allowed by the user');
    expect(gateOp(r, ctx('tab_control', undefined, { backstageAllowed: false, backstageConsent: true }))?.message).toBe('background tabs not allowed by policy');
    expect(gateOp(r, ctx('tab_control', undefined, { backstageConsent: true }))).toBeNull();
    expect(gateOp(r, ctx('view', undefined, { backstageConsent: true }))?.code).toBe('not_allowed');
  });

  it('denied tabs accept tab management but refuse content and navigation', () => {
    const c = ctx('deep_control', { 1: st({ mirrored: 'denied', host: null }) });
    expect(gateOp(req('tabs.activate', { tabId: 1 }), c)).toBeNull();
    expect(gateOp(req('tabs.pin', { tabId: 1, pinned: true }), c)).toBeNull();
    expect(gateOp(req('tabs.close', { tabIds: [1] }), c)).toBeNull();
    expect(gateOp(req('tabs.navigate', { tabId: 1, url: 'https://example.com/' }), c)?.code).toBe('denied_url');
    expect(gateOp(req('tabs.reload', { tabId: 1 }), c)?.code).toBe('denied_url');
    expect(gateOp(req('input.pointer', pointer), c)?.code).toBe('denied_url');
    expect(gateOp(req('mask.request', { tabId: 1, scope: 'tab', reason: 'x' }), c)?.code).toBe('denied_url');
  });

  it('paused tabs refuse input and navigation (tab_paused); out-of-scope and unknown tabs are refused', () => {
    const c = ctx('in_page', { 1: st({ paused: true }), 2: st({ mirrored: 'not_in_scope', inScope: false }) });
    expect(gateOp(req('input.pointer', pointer), c)?.code).toBe('tab_paused');
    expect(gateOp(req('tabs.navigate', { tabId: 1, url: 'https://example.com/' }), c)?.code).toBe('tab_paused');
    expect(gateOp(req('tabs.pin', { tabId: 1, pinned: true }), c)).toBeNull();
    expect(gateOp(req('tabs.activate', { tabId: 2 }), c)?.code).toBe('not_in_scope');
    expect(gateOp(req('tabs.close', { tabIds: [1, 2] }), c)?.code).toBe('not_in_scope');
    expect(gateOp(req('tabs.activate', { tabId: 9 }), c)?.code).toBe('no_such_tab');
    expect(gateOp(req('mirror.attach', { tabId: 2, reason: 'please' }), c)).toBeNull();
  });

  it('a backstage tab cannot be activated; unsupported tabs refuse input', () => {
    const c = ctx('in_page', { 1: st({ backstage: true }), 2: st({ mirrored: 'unsupported', host: null }) });
    expect(gateOp(req('tabs.activate', { tabId: 1 }), c)?.code).toBe('not_allowed');
    expect(gateOp(req('input.pointer', { ...pointer, tabId: 2 }), c)?.code).toBe('not_supported');
    // prd-F7: a browser / file page is never pointed elsewhere; the Assist's own new-tab page may be.
    expect(gateOp(req('tabs.navigate', { tabId: 2, url: 'https://example.com/' }), c)?.code).toBe('not_supported');
    const own = ctx('tab_control', { 3: st({ mirrored: 'unsupported', host: null, createdByAssist: true }) });
    expect(gateOp(req('tabs.navigate', { tabId: 3, url: 'https://example.com/' }), own)).toBeNull();
  });

  it('CDP input is refused below deep_control even when the tab is still in debugger mode', async () => {
    const { runControlOp } = await import('../src/background/control-ops');
    const host = { level: () => 'in_page', inputMode: () => 'debugger', contentRequest: vi.fn(), recordInput: vi.fn() };
    const r = req('input.key', { tabId: 1, kind: 'press', key: 'a', code: 'KeyA', modifiers: { alt: false, ctrl: false, meta: false, shift: false }, text: 'a' });
    await expect(runControlOp(r, 'op', host as never)).rejects.toMatchObject({ code: 'not_allowed' });
    expect(host.contentRequest).not.toHaveBeenCalled();
  });
});
