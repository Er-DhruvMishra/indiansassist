// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BAR, IndicatorBar, TitleGuard, barText } from '../src/content/indicator';
import { renderPrompts } from '../src/sidepanel/prompts';
import { installChromeMock } from './chrome-mock';

const EVIL = '<img src=x onerror="window.__pwned=1">';

function handlers() {
  return { onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onHide: vi.fn(), onPromptAnswer: vi.fn(), onCloseBackstage: vi.fn(), onHiddenTooLong: vi.fn() };
}

beforeEach(() => {
  installChromeMock();
  document.title = 'Bank form';
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.querySelectorAll('ia-indicator').forEach((n) => n.remove());
});

describe('tab bar (section 3.3)', () => {
  it('is a data-ia-block host with an important fixed style and literal text only', () => {
    const bar = new IndicatorBar(document, handlers());
    bar.mount({ technician: EVIL, org: 'Acme' });
    bar.showPrompt('p1', `Asha asks: ${EVIL}`);
    bar.toast(`Technician opened a background tab: ${EVIL}`);
    expect(bar.host.tagName).toBe('IA-INDICATOR');
    expect(bar.host.hasAttribute('data-ia-block')).toBe(true);
    expect(bar.host.style.getPropertyValue('position')).toBe('fixed');
    expect(bar.host.style.getPropertyPriority('z-index')).toBe('important');
    expect(bar.rootForTest().querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(bar.textForTest()).toContain(EVIL);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    bar.destroy();
  });

  it('shows relay, recording, deep control, revealed and background-tab state', () => {
    expect(barText({ ...DEFAULT_BAR, technician: 'Asha', org: 'Acme' })).toBe('Shared with Asha (Acme)');
    expect(barText({ ...DEFAULT_BAR, technician: 'Asha', org: 'Acme', relayed: true, backstageCount: 2 })).toBe('Shared with Asha (Acme) via server (+2 background tabs)');
    expect(barText({ ...DEFAULT_BAR, paused: true })).toBe('Paused: not shared');
    expect(barText({ ...DEFAULT_BAR, technician: 'Asha', backstage: true })).toContain("Technician's background tab");
    const bar = new IndicatorBar(document, handlers());
    bar.mount({ technician: 'Asha', recording: true, debuggerAttached: true, revealed: true });
    const text = bar.textForTest();
    expect(text).toContain('Recording');
    expect(text).toContain('DEEP CONTROL');
    expect(text).toContain('REVEALED');
    expect(text).toContain('Hide again');
    bar.destroy();
  });

  it('defends itself: re-appended when removed, style re-applied', async () => {
    const bar = new IndicatorBar(document, handlers());
    bar.mount({});
    bar.host.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(bar.host.isConnected).toBe(true);
    bar.host.style.setProperty('display', 'none');
    await new Promise((r) => setTimeout(r, 0));
    expect(bar.host.style.getPropertyValue('display')).toBe('block');
    bar.destroy();
  });

  it('pauses the tab when the bar cannot be kept visible for 3 consecutive seconds', () => {
    vi.useFakeTimers();
    const h = handlers();
    const bar = new IndicatorBar(document, h);
    bar.mount({});
    // jsdom has no layout: the rect is 0 high, so the bar counts as hidden every second.
    vi.advanceTimersByTime(2000);
    expect(h.onHiddenTooLong).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(h.onHiddenTooLong).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(h.onHiddenTooLong).toHaveBeenCalledTimes(1);
    bar.destroy();
  });

  it('buttons call the handlers (pause, stop)', () => {
    const h = handlers();
    const bar = new IndicatorBar(document, h);
    bar.mount({});
    const buttons = [...bar.rootForTest().querySelectorAll('button')];
    buttons.find((b) => b.textContent === 'Pause this tab')!.click();
    buttons.find((b) => b.textContent === 'Stop sharing')!.click();
    expect(h.onPause).toHaveBeenCalled();
    expect(h.onStop).toHaveBeenCalled();
    bar.destroy();
  });
});

describe('title prefix (section 3.3)', () => {
  it('prefixes, re-applies after an SPA title write and restores on stop', async () => {
    const g = new TitleGuard(document);
    g.start();
    expect(document.title).toBe('(Shared) Bank form');
    document.title = 'Inbox (3)';
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe('(Shared) Inbox (3)');
    g.stop();
    expect(document.title).toBe('Inbox (3)');
  });
});

describe('side panel prompt cards (section 7)', () => {
  it('render the technician reason as literal text, never markup', () => {
    const root = document.createElement('div');
    renderPrompts(root, [
      { id: 'r1', promptKind: 'mask', technician: EVIL, reason: EVIL, label: EVIL, host: 'example.com', level: null, recording: true, recordRevealed: false, expiresAt: Date.now() + 60000 },
    ]);
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.textContent).toContain(`Reason: ${EVIL}`);
    expect(root.textContent).toContain('the recording will skip the revealed value');
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Show for 60 s', 'Refuse']);
  });
});
