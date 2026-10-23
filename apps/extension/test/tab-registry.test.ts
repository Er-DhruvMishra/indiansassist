import { describe, expect, it } from 'vitest';
import { BUILTIN_DENY_LIST } from '@indiansassist/shared';
import { afterNavigation, classifyUrl, initialTabState, listForAssist, queryTabs, stripSharedPrefix, toTabInfo } from '../src/background/tab-registry';
import { makeTab } from './chrome-mock';

const DENY = [...BUILTIN_DENY_LIST, '127.0.0.1', '*.bank.example'];

describe('deny list and scheme checks (sections 4.1, 8.2)', () => {
  it('classifies schemes first, then the deny list (apex and wildcard, ports ignored)', () => {
    expect(classifyUrl('chrome://settings', DENY)).toBe('unsupported');
    expect(classifyUrl('file:///etc/passwd', DENY)).toBe('unsupported');
    expect(classifyUrl('about:blank', DENY)).toBe('unsupported');
    expect(classifyUrl(undefined, DENY)).toBe('unsupported');
    expect(classifyUrl('https://accounts.google.com/signin', DENY)).toBe('denied');
    expect(classifyUrl('http://127.0.0.1:4175/form.html', DENY)).toBe('denied');
    expect(classifyUrl('https://bank.example/', DENY)).toBe('denied');
    expect(classifyUrl('https://www.bank.example/login', DENY)).toBe('denied');
    expect(classifyUrl('https://netbanking.hdfcbank.com/x', DENY)).toBe('denied');
    expect(classifyUrl('http://localhost:4175/form.html', DENY)).toBe('ok');
  });

  it('a redirect into a denied host makes a mirrored tab denied; leaving it mirrors again only when in scope', () => {
    const st = initialTabState('https://example.com/', DENY, 'current_tab', { inScope: true });
    expect(st.mirrored).toBe('yes');
    const denied = afterNavigation(st, 'https://accounts.google.com/o/oauth2', DENY, 'current_tab');
    expect(denied).toMatchObject({ mirrored: 'denied', host: null });
    expect(afterNavigation(denied, 'https://example.com/done', DENY, 'current_tab').mirrored).toBe('yes');
    const other = initialTabState('https://accounts.google.com/', DENY, 'current_tab', { inScope: false });
    expect(afterNavigation(other, 'https://example.com/', DENY, 'current_tab').mirrored).toBe('not_in_scope');
    expect(afterNavigation(other, 'https://example.com/', DENY, 'all_tabs').mirrored).toBe('yes');
  });

  it('Assist-created and backstage tabs are mirrored under either scope', () => {
    expect(initialTabState('https://example.com/', DENY, 'current_tab', { inScope: false, createdByAssist: true }).mirrored).toBe('yes');
    expect(initialTabState('https://example.com/', DENY, 'current_tab', { inScope: false, backstage: true })).toMatchObject({ mirrored: 'yes', backstage: true });
  });
});

describe('TabInfo disclosure (section 4.5)', () => {
  it('denied and not_in_scope tabs carry no title, url or favicon; unsupported carry title and url only', () => {
    const denied = toTabInfo(makeTab(1, 'https://accounts.google.com/x?token=1', { title: 'Sign in' }), initialTabState('https://accounts.google.com/', DENY, 'all_tabs', { inScope: true }), 'data:image/png;base64,AA');
    expect(denied).toMatchObject({ mirrored: 'denied', title: null, url: null, favicon: null });
    const unsupported = toTabInfo(makeTab(2, 'chrome://settings/', { title: 'Settings' }), initialTabState('chrome://settings/', DENY, 'all_tabs', { inScope: true }), 'data:image/png;base64,AA');
    expect(unsupported).toMatchObject({ mirrored: 'unsupported', title: 'Settings', url: 'chrome://settings/', favicon: null });
    const ok = toTabInfo(makeTab(3, 'https://example.com/a?q=secret#frag', { title: '(Shared) Example' }), initialTabState('https://example.com/', DENY, 'all_tabs', { inScope: true }), null);
    expect(ok).toMatchObject({ title: 'Example', url: 'https://example.com/a', mirrored: 'yes' });
    expect(stripSharedPrefix('(Shared) (Shared) X')).toBe('X');
  });

  it('current_tab lists only shared tabs; tabs.query never matches hidden tabs by urlHost', () => {
    const states = [
      initialTabState('https://example.com/', DENY, 'current_tab', { inScope: true }),
      initialTabState('https://other.example/', DENY, 'current_tab', { inScope: false }),
      initialTabState('http://127.0.0.1:4175/', DENY, 'current_tab', { inScope: true }),
    ];
    const infos = [makeTab(1, 'https://example.com/'), makeTab(2, 'https://other.example/'), makeTab(3, 'http://127.0.0.1:4175/')].map((t, i) => toTabInfo(t, states[i], null)!);
    const listed = listForAssist(infos, 'current_tab');
    expect(listed.tabs.map((t) => t.tabId)).toEqual([1]);
    expect(listed.hiddenCount).toBe(2);
    const hosts = new Map<number, string | null>([
      [1, 'example.com'],
      [2, 'other.example'],
      [3, '127.0.0.1'],
    ]);
    expect(queryTabs(infos, hosts, { urlHost: '127.0.0.1' }).tabs).toHaveLength(0);
    expect(queryTabs(infos, hosts, { urlHost: 'other.example' }).tabs).toHaveLength(0);
    expect(queryTabs(infos, hosts, { urlHost: 'example.com' }).tabs.map((t) => t.tabId)).toEqual([1]);
  });
});
