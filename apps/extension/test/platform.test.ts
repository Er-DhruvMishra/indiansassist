import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXTENSION_POLICY } from '@indiansassist/shared';
import { ContentRegistry } from '../src/background/content-registry';
import { effectivePolicy } from '../src/background/policy';
import { busListener } from '../src/shared/bus';
import { LOCAL_KEYS, SESSION_KEYS, readManaged, writeLocal, writeSession } from '../src/shared/storage';
import { installChromeMock, type ChromeMock } from './chrome-mock';

let chrome: ChromeMock;
beforeEach(() => {
  chrome = installChromeMock({ managed: { maxConsentLevel: 'in_page', extraDenyList: ['corp.example'], allowBackstage: false, bogus: 1 } });
});

describe('bus addressing (section 9.3)', () => {
  it('a listener ignores messages for another context synchronously and answers its own once', async () => {
    const ui = vi.fn();
    const off = vi.fn(async () => ({ ok: true }));
    const uiL = busListener('ui', ui);
    const offL = busListener('offscreen', off);
    const respond = vi.fn();
    const msg = { to: 'offscreen', t: 'pc.close' };
    expect(uiL(msg, {}, respond)).toBe(false);
    expect(ui).not.toHaveBeenCalled();
    expect(offL(msg, {}, respond)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(uiL({ t: 'x' }, {}, respond)).toBe(false);
  });
});

describe('storage (section 9.4)', () => {
  it('only the four local keys can reach chrome.storage.local', async () => {
    await writeLocal(LOCAL_KEYS.apiOrigin, 'https://in.indiansassist.example');
    await expect(writeLocal('ia.session' as never, { code: 'secret' })).rejects.toThrow('not a local storage key');
    await expect(writeLocal('ia.policyCache' as never, {})).rejects.toThrow();
    await writeSession(SESSION_KEYS.session, { phase: 'idle' });
    expect(Object.keys(chrome.storage.local.data)).toEqual(['ia.apiOrigin']);
    expect(Object.keys(chrome.storage.session.data)).toEqual(['ia.session']);
  });

  it('reads the managed policy and drops unknown keys', async () => {
    expect(await readManaged()).toEqual({ maxConsentLevel: 'in_page', extraDenyList: ['corp.example'], allowBackstage: false });
  });
});

describe('effective policy with managed caps (sections 5.2, 9.4)', () => {
  it('takes the stricter of org and managed policy', () => {
    const e = effectivePolicy({ ...DEFAULT_EXTENSION_POLICY, denyList: ['org.example'] }, { maxConsentLevel: 'tab_control', allowAllTabs: false, extraDenyList: ['corp.example'] });
    expect(e.maxLevel).toBe('tab_control');
    expect(e.defaultLevel).toBe('tab_control');
    expect(e.allowAllTabs).toBe(false);
    expect(e.denyList).toEqual(expect.arrayContaining(['org.example', 'corp.example', 'accounts.google.com']));
    expect(e.managedLimited).toBe(true);
    expect(effectivePolicy({ ...DEFAULT_EXTENSION_POLICY, allowDeepControl: false }).maxLevel).toBe('in_page');
    expect(effectivePolicy({ ...DEFAULT_EXTENSION_POLICY }, { allowDeepControl: false }).maxLevel).toBe('in_page');
    expect(effectivePolicy({ ...DEFAULT_EXTENSION_POLICY }).managedLimited).toBe(false);
  });
});

describe('capture script injection (section 9.2)', () => {
  it('registers for all_tabs with excludeMatches from the deny list and unregisters at teardown', async () => {
    const stops: number[] = [];
    const r = new ContentRegistry({ onInjectFailed: vi.fn(), sendStop: (id) => void stops.push(id) });
    await r.registerAllTabs(['accounts.google.com', '*.bank.example']);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
      {
        id: 'ia-capture',
        matches: ['http://*/*', 'https://*/*'],
        excludeMatches: ['*://accounts.google.com/*', '*://*.bank.example/*', '*://bank.example/*'],
        js: ['content.js'],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: false,
      },
    ]);
    await r.inject(4);
    r.ready(4);
    await r.teardown();
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: ['ia-capture'] });
    expect(stops).toEqual([4]);
  });

  it('an injection that rejects, or never sends cs.ready within 3 s, is inject_failed', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const r = new ContentRegistry({ onInjectFailed: failed, sendStop: vi.fn() });
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    expect(await r.inject(5)).toBe(false);
    expect(failed).toHaveBeenCalledWith(5);
    expect(await r.inject(6)).toBe(true);
    vi.advanceTimersByTime(3001);
    expect(failed).toHaveBeenCalledWith(6);
    expect(await r.inject(7)).toBe(true);
    r.ready(7);
    vi.advanceTimersByTime(5000);
    expect(failed).not.toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });
});

describe('ASCII-only bundles (Chrome rejects content scripts with Unicode noncharacters)', () => {
  it('escapes every non-ASCII character', async () => {
    const { asciiOnly } = await import('../scripts/ascii.mjs');
    const input = `a${String.fromCharCode(0xfffe)}b${String.fromCharCode(0x25cf)}"${String.fromCharCode(0xe9)}"`;
    const bs = String.fromCharCode(92);
    expect(asciiOnly(input)).toBe(`a${bs}ufffeb${bs}u25cf"${bs}u00e9"`);
    expect(/^[ -~]*$/.test(asciiOnly(input))).toBe(true);
    expect(asciiOnly('plain')).toBe('plain');
  });
});
