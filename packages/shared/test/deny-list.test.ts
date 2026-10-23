import { describe, expect, it } from 'vitest';
import {
  BUILTIN_DENY_LIST,
  denyListToMatchPatterns,
  effectiveDenyList,
  hostOf,
  isMirrorableUrl,
  isWireHost,
  matchesDenyList,
  normaliseHostPattern,
  stripUrlForMirror,
} from '../src/index.js';

describe('normaliseHostPattern', () => {
  it('lower-cases, converts IDNA and keeps a *. prefix', () => {
    expect(normaliseHostPattern('Example.COM')).toBe('example.com');
    expect(normaliseHostPattern('*.Example.com')).toBe('*.example.com');
    expect(normaliseHostPattern('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normaliseHostPattern('127.0.0.1')).toBe('127.0.0.1');
    expect(normaliseHostPattern('example.com.')).toBe('example.com');
  });
  it('refuses ports, paths, inner wildcards, schemes and over-broad wildcards', () => {
    for (const bad of ['example.com:8080', 'example.com/x', 'a.*.example.com', 'https://example.com', '*.com', '*', '', 'ex ample.com', '-bad.com', `${'a'.repeat(250)}.com`])
      expect(normaliseHostPattern(bad), bad).toBeNull();
  });
  it('isWireHost accepts only normalised bare hostnames', () => {
    expect(isWireHost('example.com')).toBe(true);
    expect(isWireHost('Example.com')).toBe(false);
    expect(isWireHost('*.example.com')).toBe(false);
    expect(isWireHost('example.com:443')).toBe(false);
  });
});

describe('matchesDenyList', () => {
  const list = ['example.com', '*.bank.test'];
  it('matches exact hosts case-insensitively and ignores ports', () => {
    expect(matchesDenyList('https://EXAMPLE.com:8443/a?b#c', list)).toBe(true);
    expect(matchesDenyList('https://www.example.com/', list)).toBe(false);
  });
  it('wildcards match subdomains and the apex', () => {
    expect(matchesDenyList('https://bank.test/', list)).toBe(true);
    expect(matchesDenyList('https://a.b.bank.test/', list)).toBe(true);
    expect(matchesDenyList('https://notbank.test/', list)).toBe(false);
  });
  it('matches IDNA hosts and the built-in list', () => {
    expect(matchesDenyList('https://bücher.example/', ['xn--bcher-kva.example'])).toBe(true);
    expect(matchesDenyList('https://accounts.google.com/signin', [...BUILTIN_DENY_LIST])).toBe(true);
    expect(matchesDenyList('https://retail.onlinesbi.sbi/', [...BUILTIN_DENY_LIST])).toBe(true);
    expect(matchesDenyList('not a url', list)).toBe(false);
  });
  it('effectiveDenyList unions built-ins with org and managed lists', () => {
    const eff = effectiveDenyList(['Foo.test'], ['*.bar.test', 'bad entry']);
    expect(eff).toContain('foo.test');
    expect(eff).toContain('*.bar.test');
    expect(eff).toContain('accounts.google.com');
    expect(eff).not.toContain('bad entry');
  });
});

describe('url helpers', () => {
  it('isMirrorableUrl is http(s) only', () => {
    expect(isMirrorableUrl('https://a.test/')).toBe(true);
    expect(isMirrorableUrl('http://localhost:5173/x')).toBe(true);
    for (const u of ['chrome://settings', 'file:///c:/x', 'javascript:alert(1)', 'about:blank', 'data:text/html,x', 'view-source:https://a.test', 'chrome-extension://abc/x.html'])
      expect(isMirrorableUrl(u), u).toBe(false);
  });
  it('denyListToMatchPatterns adds the apex for wildcards', () => {
    expect(denyListToMatchPatterns(['example.com', '*.bank.test'])).toEqual([
      '*://example.com/*',
      '*://*.bank.test/*',
      '*://bank.test/*',
    ]);
  });
  it('stripUrlForMirror keeps origin and path only', () => {
    expect(stripUrlForMirror('https://user:pw@a.test:8443/p/q?token=1#t=2')).toBe('https://a.test:8443/p/q');
    expect(stripUrlForMirror('chrome://settings/privacy?x=1')).toBe('chrome://settings/privacy');
    expect(stripUrlForMirror('about:blank')).toBe('about:blank');
    expect(stripUrlForMirror('::')).toBeNull();
    expect(hostOf('https://WWW.A.test:1/x')).toBe('www.a.test');
  });
});
