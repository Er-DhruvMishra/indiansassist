/**
 * Service-worker restart persistence (section 3.5): the capture registration, debugger attachments and the consent
 * window survive in `ia.session` (F1, F2, F10); a lost `consent.ok` still starts the session (F6); level requests
 * are correlated by frame id (F11); a PC rebuild resets the open channels (F7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUiCommand } from '../src/background/commands';
import { restoreConsentWindow } from '../src/background/consent-window';
import { stopSharing } from '../src/background/session-end';
import { installChromeMock, makeTab, offscreenSent, type ChromeMock } from './chrome-mock';
import { FakeWS } from './fake-ws';
import { ICE, SID, created, helloOk, machine, tick, toActive, toConsent } from './session-helpers';

let chrome: ChromeMock;
let openWindow: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeWS.reset();
  chrome = installChromeMock({ tabs: [makeTab(1, 'https://example.com/', { active: true }), makeTab(2, 'https://example.org/')] });
  openWindow = vi.fn(async () => 55);
});

const persisted = () => chrome.storage.session.data['ia.session'] as Record<string, unknown>;
const mk = () => machine(openWindow as never);

describe('worker restart during active (F1, F2)', () => {
  it('an all_tabs capture registration is still unregistered at Stop sharing after a restart (F1)', async () => {
    await toActive(mk(), 'all_tabs');
    await tick(5);
    expect(persisted().captureRegistered).toBe(true);
    const m = mk();
    await m.restore();
    expect(m.live!.registry.isRegistered).toBe(true);
    chrome.scripting.unregisterContentScripts.mockClear();
    await stopSharing(m, true);
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: ['ia-capture'] });
  });

  it('teardown unregisters even when the in-memory flag was lost (F1)', async () => {
    await toActive(mk(), 'all_tabs');
    await tick(5);
    chrome.storage.session.data['ia.session'] = { ...persisted(), captureRegistered: false };
    const m = mk();
    await m.restore();
    chrome.scripting.unregisterContentScripts.mockClear();
    await stopSharing(m, true);
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: ['ia-capture'] });
  });

  it('a debugger attachment survives the restart: lowering the level detaches it and CDP input stops (F2)', async () => {
    chrome.permissionsSet.add('debugger');
    const first = mk();
    await toActive(first, 'current_tab', 'deep_control');
    await first.live!.control.handle({ t: 'ctl.req', id: 'mode-1', op: 'input.mode', args: { tabId: 1, mode: 'debugger' }, ts: 1 });
    await tick(5);
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    expect(persisted().debuggerTabs).toEqual([1]);
    const m = mk();
    await m.restore();
    expect([...m.live!.debuggerControl.attached]).toEqual([1]);
    expect(m.live!.barFor(1).debuggerAttached).toBe(true);
    await handleUiCommand(m, { to: 'worker', t: 'ui.level', level: 'in_page' });
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(m.live!.inputMode(1)).toBe('dom');
    await stopSharing(m, true);
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
  });
});

describe('worker restart during consent_pending (F10)', () => {
  it('keeps the consent prompt; a window closed while the worker was down is a Decline', async () => {
    chrome.windows.open.add(55);
    await toConsent(mk());
    await tick(5);
    expect(persisted()).toMatchObject({ consentWindowId: 55, consentInfo: expect.objectContaining({ sessionId: SID }) });
    const m = mk();
    await m.restore();
    expect(m.consentWindowId).toBe(55);
    expect(m.ui.current.consent).toMatchObject({ sessionId: SID });
    await restoreConsentWindow(m); // still open: nothing happens
    expect(m.s?.endedLocally).toBe(false);
    chrome.windows.open.delete(55);
    await restoreConsentWindow(m);
    expect(m.s?.endedLocally).toBe(true);
    const ws = FakeWS.last();
    ws.open();
    ws.recv(helloOk('consent_pending'));
    expect(ws.of('desk.consent')).toEqual([expect.objectContaining({ state: 'revoked' })]);
  });

  it('opens the prompt when the old worker died before opening it', async () => {
    await toConsent(mk());
    await tick(5);
    chrome.storage.session.data['ia.session'] = { ...persisted(), consentWindowId: null };
    openWindow.mockClear();
    const m = mk();
    await m.restore();
    await restoreConsentWindow(m);
    expect(openWindow.mock.calls.map((c) => c[0])).toEqual([`consent.html?sessionId=${SID}`]);
  });
});

describe('resume edge cases', () => {
  it('a lost consent.ok: the resumed session.created active starts the session on the next ice.refresh (F6)', async () => {
    const m = mk();
    const ws = await toConsent(m);
    await handleUiCommand(m, { to: 'worker', t: 'ui.consent', decision: 'share', level: 'tab_control', scope: 'current_tab', backstage: false, tabId: 1 });
    // consent.ok never arrives; the reconnect resumes straight into active.
    ws.recv(helloOk('active'));
    ws.recv(created('active'));
    await tick(5);
    expect(m.phase).toBe('active');
    ws.recv(ICE);
    await vi.waitFor(() => expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] }));
    expect(offscreenSent(chrome, 'pc.create')).toEqual([expect.objectContaining({ restart: true })]);
    expect(m.s!.tabs['1']).toMatchObject({ mirrored: 'yes' });
    expect(m.s!.startedAt).not.toBeNull();
    await vi.waitFor(() => expect(ws.of('desk.event').find((e) => e.action === 'mirror.started')).toMatchObject({ data: expect.objectContaining({ reason: 'consent', tabCount: 1 }) }));
  });

  it('level.request waits for the consent.level_ok answering its own frame; unrelated errors do not resolve it (F11)', async () => {
    const m = mk();
    const ws = await toActive(m);
    let result: boolean | undefined;
    void m.live!.requestLevel('in_page', '0123456789abcdef').then((ok) => (result = ok));
    const frame = ws.of('desk.consent_level')[0]!;
    expect(frame).toMatchObject({ requested: true, opId: '0123456789abcdef', id: expect.stringMatching(/^lv/) });
    ws.recv({ t: 'error', code: 'bad_payload', message: 'chat too long' });
    ws.recv({ t: 'consent.level_ok', re: 'lv-other', sessionId: SID, level: 'in_page', backstage: false });
    await tick(5);
    expect(result).toBeUndefined();
    ws.recv({ t: 'consent.level_ok', re: frame.id, sessionId: SID, level: 'in_page', backstage: false });
    await tick(5);
    expect(result).toBe(true);
    expect(m.levelWaiters.size).toBe(0);
    void m.live!.requestLevel('deep_control', '0123456789abcdee').then((ok) => (result = ok));
    ws.recv({ t: 'error', re: ws.of('desk.consent_level')[1]!.id, code: 'bad_payload', message: 'above the maximum' });
    await tick(5);
    expect(result).toBe(false);
  });

  it('a PC rebuild forgets the old channels, so chat goes over the WS until ia.chat reopens (F7)', async () => {
    const m = mk();
    const ws = await toActive(m);
    m.live!.onChannelOpen('ia.chat');
    await m.live!.rebuild([]);
    expect(m.live!.openChannels.size).toBe(0);
    await m.live!.sendChat('hello');
    expect(ws.of('chat.message')).toEqual([expect.objectContaining({ text: 'hello', from: 'desk' })]);
    // The channel looked open but the offscreen document could not send: the WS carries it.
    m.live!.onChannelOpen('ia.chat');
    chrome.runtimeReply.mockImplementation((msg: unknown) => ((msg as { t?: string }).t === 'dc.send' ? { ok: false } : { ok: true }));
    await m.live!.sendChat('again');
    expect(ws.of('chat.message').map((x) => x.text)).toEqual(['hello', 'again']);
  });
});
