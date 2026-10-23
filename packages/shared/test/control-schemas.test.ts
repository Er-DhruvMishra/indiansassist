import { describe, expect, it } from 'vitest';
import {
  CONTROL_OPS,
  controlEventSchema,
  controlMessageSchema,
  controlRequestSchema,
  controlResponseSchema,
  minLevelFor,
  opIdFor,
  parseDataChannelMessage,
  sha256Hex,
  TAB_ACTION_KINDS,
  tabInfoSchema,
} from '../src/index.js';

const mods = { alt: false, ctrl: false, meta: false, shift: false };
const req = (op: string, args: unknown) => ({ t: 'ctl.req', id: 'r1', op, args, ts: 1 });
const ok = (op: string, args: unknown) => controlRequestSchema.safeParse(req(op, args)).success;

export const TAB: Record<string, unknown> = {
  tabId: 12,
  windowId: 1,
  index: 0,
  title: 'Form',
  url: 'http://localhost:4175/form.html',
  favicon: null,
  active: true,
  pinned: false,
  muted: false,
  audible: false,
  groupId: -1,
  status: 'complete',
  mirrored: 'yes',
  backstage: false,
  createdByAssist: false,
  revealed: 'none',
  discarded: false,
};

describe('control requests', () => {
  it('every op has a schema and a min level', () => {
    expect(CONTROL_OPS).toHaveLength(29);
    for (const op of CONTROL_OPS) expect(['view', 'tab_control', 'in_page', 'deep_control']).toContain(minLevelFor(op));
    for (const k of TAB_ACTION_KINDS) expect(minLevelFor(k)).toBe('tab_control');
    expect(minLevelFor('input.pointer')).toBe('in_page');
    expect(minLevelFor('input.mode', { mode: 'debugger' })).toBe('deep_control');
    expect(minLevelFor('input.mode', { mode: 'dom' })).toBe('in_page');
    expect(minLevelFor('level.request')).toBe('view');
  });

  it('url fields accept http(s) only', () => {
    expect(ok('tabs.navigate', { tabId: 1, url: 'https://a.test/x' })).toBe(true);
    for (const url of ['chrome://settings', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank'])
      expect(ok('tabs.navigate', { tabId: 1, url }), url).toBe(false);
    expect(ok('tabs.create', {})).toBe(true);
    expect(ok('backstage.enter', { url: 'view-source:https://a.test' })).toBe(false);
  });

  it('args are strict and bounded', () => {
    expect(ok('tabs.list', { extra: 1 })).toBe(false);
    expect(ok('tabs.close', { tabIds: [] })).toBe(false);
    expect(ok('tabs.close', { tabIds: Array.from({ length: 51 }, (_, i) => i) })).toBe(false);
    expect(ok('tabs.close', { tabIds: Array.from({ length: 50 }, (_, i) => i) })).toBe(true);
    expect(ok('input.fill', { tabId: 1, nodeId: 3, value: 'x'.repeat(4001), commit: true })).toBe(false);
    expect(ok('no.such.op', {})).toBe(false);
    expect(controlRequestSchema.safeParse({ ...req('tabs.list', {}), id: 'x'.repeat(41) }).success).toBe(false);
  });

  it('level.request needs a reason for in_page and deep_control', () => {
    expect(ok('level.request', { level: 'tab_control' })).toBe(true);
    expect(ok('level.request', { level: 'in_page' })).toBe(false);
    expect(ok('level.request', { level: 'deep_control', reason: 'printer driver' })).toBe(true);
  });

  it('input.pointer needs nx/ny when nodeId is a number; mask.request field needs nodeId', () => {
    const base = { tabId: 1, kind: 'click', vx: 0.5, vy: 0.5, modifiers: mods };
    expect(ok('input.pointer', { ...base, nodeId: null })).toBe(true);
    expect(ok('input.pointer', { ...base, nodeId: 4 })).toBe(false);
    expect(ok('input.pointer', { ...base, nodeId: 4, nx: 0.1, ny: 0.2 })).toBe(true);
    expect(ok('input.pointer', { ...base, nodeId: null, vx: 1.5 })).toBe(false);
    expect(ok('mask.request', { tabId: 1, scope: 'field', reason: 'r' })).toBe(false);
    expect(ok('mask.request', { tabId: 1, scope: 'tab', reason: 'r' })).toBe(true);
  });

  it('responses, events and the message union', () => {
    expect(controlResponseSchema.safeParse({ t: 'ctl.res', id: 'r1', ok: true, result: {}, ts: 1 }).success).toBe(true);
    expect(controlResponseSchema.safeParse({ t: 'ctl.res', id: 'r1', ok: false, error: { code: 'not_allowed', message: 'no' }, ts: 1 }).success).toBe(true);
    expect(controlResponseSchema.safeParse({ t: 'ctl.res', id: 'r1', ok: false, error: { code: 'nope', message: '' }, ts: 1 }).success).toBe(false);
    const prompt = { t: 'ctl.event', kind: 'prompt', id: 'r1', promptKind: 'mask', state: 'shown', opId: 'abcdef0123456789', ts: 1 };
    expect(controlEventSchema.safeParse(prompt).success).toBe(true);
    expect(controlEventSchema.safeParse({ ...prompt, promptKind: 'other' }).success).toBe(false);
    expect(controlMessageSchema.safeParse(req('tabs.list', {})).success).toBe(true);
    expect(controlMessageSchema.safeParse({ t: 'ctl.event', kind: 'level', level: 'view', scope: 'all_tabs', backstage: true, ts: 1 }).success).toBe(true);
  });

  it('opIdFor is the first 16 hex of sha256(sessionId:reqId)', () => {
    expect(opIdFor('s', 'r')).toBe(sha256Hex('s:r').slice(0, 16));
    expect(opIdFor('s', 'r')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('TabInfo and the data channel union', () => {
  it('favicon is a data:image URL of bounded size or null', () => {
    expect(tabInfoSchema.safeParse(TAB).success).toBe(true);
    expect(tabInfoSchema.safeParse({ ...TAB, favicon: 'data:image/png;base64,AAAA' }).success).toBe(true);
    expect(tabInfoSchema.safeParse({ ...TAB, favicon: 'https://a.test/favicon.ico' }).success).toBe(false);
    expect(tabInfoSchema.safeParse({ ...TAB, favicon: `data:image/png;base64,${'A'.repeat(11000)}` }).success).toBe(false);
  });
  it('denied tabs disclose no title, url or favicon', () => {
    expect(tabInfoSchema.safeParse({ ...TAB, mirrored: 'denied' }).success).toBe(false);
    expect(tabInfoSchema.safeParse({ ...TAB, mirrored: 'denied', title: null, url: null }).success).toBe(true);
  });
  it('ia.mirror and ia.control frames parse on their channel only', () => {
    const tabs = JSON.stringify({ t: 'mirror.tabs', tabs: [TAB], hiddenCount: 2, activeTabId: 12, focusedTabId: 12, ts: 1 });
    expect(parseDataChannelMessage('ia.mirror', tabs).ok).toBe(true);
    expect(parseDataChannelMessage('ia.chat', tabs)).toEqual({ ok: false, reason: 'wrong_channel' });
    expect(parseDataChannelMessage('ia.mirror', JSON.stringify({ t: 'mirror.nack', tabId: 1, seq: 4, ts: 1 })).ok).toBe(true);
    expect(parseDataChannelMessage('ia.control', JSON.stringify(req('windows.list', {}))).ok).toBe(true);
    const annot = { t: 'annot', id: '00000000-0000-4000-8000-000000000001', shape: 'rect', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, ts: 1, tabId: 12 };
    expect(parseDataChannelMessage('ia.annot', JSON.stringify(annot)).ok).toBe(true);
  });
});
