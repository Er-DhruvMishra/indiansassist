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

  it('scope comes before the scheme and the deny list: an unshared tab is not_in_scope whatever its URL (SEC-P2-03)', () => {
    for (const u of ['file:///C:/Users/x/tax-return.pdf', 'chrome://settings/passwords', 'about:blank', 'https://netbanking.hdfcbank.com/'])
      expect(initialTabState(u, DENY, 'current_tab', { inScope: false }).mirrored).toBe('not_in_scope');
    const other = initialTabState('https://example.org/', DENY, 'current_tab', { inScope: false });
    // An unshared tab navigating into a protected host stays not_in_scope, so no mirror.tab 'denied' leaks (SEC-P2-07).
    expect(afterNavigation(other, 'https://netbanking.hdfcbank.com/', DENY, 'current_tab').mirrored).toBe('not_in_scope');
    expect(afterNavigation(other, 'chrome://downloads/', DENY, 'current_tab').mirrored).toBe('not_in_scope');
    expect(initialTabState('file:///x', DENY, 'all_tabs', { inScope: false }).mirrored).toBe('unsupported');
    const info = toTabInfo(makeTab(9, 'file:///C:/Users/x/tax-return.pdf', { title: 'tax-return.pdf' }), initialTabState('file:///C:/Users/x/tax-return.pdf', DENY, 'current_tab', { inScope: false }), null);
    expect(info).toMatchObject({ mirrored: 'not_in_scope', title: null, url: null });
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
    const unsupported = toTabInfo(makeTab(2, 'chrome://settings/passwords', { title: 'Settings' }), initialTabState('chrome://settings/', DENY, 'all_tabs', { inScope: true }), 'data:image/png;base64,AA');
    expect(unsupported).toMatchObject({ mirrored: 'unsupported', title: 'Settings', url: 'chrome://settings/', favicon: null });
    const ok = toTabInfo(makeTab(3, 'https://example.com/a?q=secret#frag', { title: '(Shared) Example' }), initialTabState('https://example.com/', DENY, 'all_tabs', { inScope: true }), null);
    expect(ok).toMatchObject({ title: 'Example', url: 'https://example.com/a', mirrored: 'yes' });
    expect(stripSharedPrefix('(Shared) (Shared) X')).toBe('X');
  });

  it('unsupported file:, data:, blob:, view-source: and extension tabs disclose only their scheme (prd-F6)', () => {
    const info = (url: string, title = 'Private') => toTabInfo(makeTab(4, url, { title }), initialTabState(url, DENY, 'all_tabs', { inScope: true }), null)!;
    expect(info('file:///C:/Users/asha/Downloads/salary-slip.pdf')).toMatchObject({ url: 'file:', title: null });
    expect(info('data:text/html,<h1>secret</h1>')).toMatchObject({ url: 'data:', title: null });
    expect(info('blob:https://example.com/3f1c')).toMatchObject({ url: 'blob:', title: null });
    expect(info('view-source:https://example.com/a?token=1')).toMatchObject({ url: 'view-source:', title: null });
    expect(info('chrome-extension://abcdefghijklmnop/page.html')).toMatchObject({ url: 'chrome-extension://abcdefghijklmnop/', title: null });
    expect(info('about:blank')).toMatchObject({ url: 'about:blank', title: null });
    // An http(s) page that refused the script (inject_failed) is an ordinary shared page.
    const failed = { ...initialTabState('https://example.com/', DENY, 'all_tabs', { inScope: true }), mirrored: 'unsupported' as const, error: 'inject_failed' as const };
    expect(toTabInfo(makeTab(5, 'https://example.com/a?q=1', { title: 'Shop' }), failed, null)).toMatchObject({ url: 'https://example.com/a', title: 'Shop', error: 'inject_failed' });
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
