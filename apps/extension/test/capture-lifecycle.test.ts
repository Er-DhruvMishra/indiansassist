/**
 * Capture injection across reloads, pause / resume and teardown (section 9.2): a reload waits for the new document
 * (F3), a paused tab that navigated is re-injected on resume (F5), and nothing restarts while Stop sharing tears
 * down (F4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleContentMessage } from '../src/background/commands';
import type { SessionMachine } from '../src/background/session-machine';
import { installChromeMock, makeTab, type ChromeMock } from './chrome-mock';
import { FakeWS } from './fake-ws';
import { machine, tick, toActive } from './session-helpers';

let chrome: ChromeMock;

beforeEach(() => {
  FakeWS.reset();
  chrome = installChromeMock({ tabs: [makeTab(1, 'https://example.com/', { active: true }), makeTab(2, 'https://example.org/')] });
});

async function live(): Promise<SessionMachine> {
  const m = machine(vi.fn(async () => 55) as never);
  await toActive(m);
  await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1));
  expect(await handleContentMessage(m, { to: 'worker', t: 'cs.ready' }, 1)).toEqual({ ok: true });
  expect(m.s!.tabs['1']!.injected).toBe(true);
  chrome.scripting.executeScript.mockClear();
  chrome.tabSent.length = 0;
  return m;
}

const tab = (status: 'loading' | 'complete', url = 'https://example.com/') => {
  const t = chrome.tabsStore.get(1)!;
  Object.assign(t, { status, url });
  return { ...t };
};

describe('reload of a shared tab (F3)', () => {
  it('a same-URL load waits for complete instead of injecting into the old document', async () => {
    const m = await live();
    await m.live!.tabs.onUpdated(1, { status: 'loading' }, tab('loading'));
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(m.s!.tabs['1']).toMatchObject({ mirrored: 'yes', injected: false });
    await m.live!.tabs.onUpdated(1, { status: 'complete' }, tab('complete'));
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] });
  });

  it('no cs.ready while the tab is still loading keeps it shared; a loaded page that never answers is inject_failed', async () => {
    const m = await live();
    tab('loading');
    await m.live!.tabs.injectFailed(1);
    expect(m.s!.tabs['1']).toMatchObject({ mirrored: 'yes', injected: false });
    expect(m.s!.tabs['1']!.error).toBeUndefined();
    tab('complete');
    await m.live!.tabs.injectFailed(1);
    expect(m.s!.tabs['1']).toMatchObject({ mirrored: 'unsupported', error: 'inject_failed' });
  });
});

describe('pause, navigate, resume (F5)', () => {
  it('resuming a paused tab that navigated injects the capture script again', async () => {
    const m = await live();
    await m.live!.tabs.pause(1, true);
    await m.live!.tabs.onUpdated(1, { status: 'loading', url: 'https://example.com/next' }, tab('loading', 'https://example.com/next'));
    await m.live!.tabs.onUpdated(1, { status: 'complete' }, tab('complete', 'https://example.com/next'));
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    chrome.tabSent.length = 0;
    await m.live!.tabs.pause(1, false);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] });
    expect(chrome.tabSent.map((x) => (x.msg as { t: string }).t)).not.toContain('cs.resume');
    await handleContentMessage(m, { to: 'worker', t: 'cs.ready' }, 1);
    const start = chrome.tabSent.find((x) => (x.msg as { t: string }).t === 'cs.start')!.msg as { bar: { paused: boolean } };
    expect(start.bar.paused).toBe(false);
    expect(chrome.tabSent.map((x) => (x.msg as { t: string }).t)).not.toContain('cs.pause');
  });

  it('resuming a paused tab whose script still runs only sends cs.resume', async () => {
    const m = await live();
    await m.live!.tabs.pause(1, true);
    await m.live!.tabs.pause(1, false);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabSent.map((x) => (x.msg as { t: string }).t)).toContain('cs.resume');
  });
});

describe('teardown in progress (F4)', () => {
  it('nothing is injected or started while sharing is ending', async () => {
    const m = await live();
    m.live!.finishing = true;
    await m.live!.tabs.onUpdated(1, { status: 'loading', url: 'https://example.com/next' }, tab('loading', 'https://example.com/next'));
    await m.live!.tabs.onUpdated(1, { status: 'complete' }, tab('complete', 'https://example.com/next'));
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(await handleContentMessage(m, { to: 'worker', t: 'cs.ready' }, 1)).toEqual({ ok: false });
    const sent = chrome.tabSent.map((x) => (x.msg as { t: string }).t);
    expect(sent).toContain('cs.stop');
    expect(sent).not.toContain('cs.start');
    expect(await handleContentMessage(m, { to: 'worker', t: 'cs.pauseClicked' }, 1)).toBeUndefined();
    expect(m.s!.tabs['1']!.paused).toBe(false);
    await tick(1);
  });
});
