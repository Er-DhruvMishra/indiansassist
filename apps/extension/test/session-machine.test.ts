import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXTENSION_POLICY, opIdFor } from '@indiansassist/shared';
import { handleUiCommand } from '../src/background/commands';
import { LiveSession } from '../src/background/live-session';
import { stopSharing } from '../src/background/session-end';
import { SessionMachine } from '../src/background/session-machine';
import { EXT_ID, installChromeMock, makeTab, offscreenSent, type ChromeMock } from './chrome-mock';
import { FakeWS } from './fake-ws';

const ORIGIN = 'https://in.indiansassist.example';
const SID = '00000000-0000-4000-8000-000000000010';
const UUID = '00000000-0000-4000-8000-000000000001';
const ASSIST = { id: '00000000-0000-4000-8000-000000000002', name: 'Asha' };
const ORG = { displayName: 'Acme', accentColor: null, logoData: null };
const TS = '2030-01-01T00:00:00.000Z';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function lookupFetch() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        tokenId: UUID,
        tier: 'p2_extension',
        typ: 'one_time',
        expiresAt: TS,
        region: 'in-mum',
        org: { ...ORG, supportEmail: null },
        technician: { name: 'Asha' },
        signalUrl: 'wss://in.indiansassist.example/signal',
        joinSupported: true,
        extension: null,
      }),
      { status: 200 },
    ),
  );
}

function created(state: 'consent_pending' | 'active', policy = DEFAULT_EXTENSION_POLICY) {
  return { t: 'session.created', sessionId: SID, tokenId: UUID, tier: 'p2_extension', state, consentState: state === 'active' ? 'granted' : 'pending', assist: ASSIST, desk: { label: 'Desk' }, org: ORG, polite: false, extension: { policy } };
}

let chrome: ChromeMock;
let openWindow: ReturnType<typeof vi.fn>;

function machine(): SessionMachine {
  const m = new SessionMachine({ extensionId: EXT_ID, WebSocketImpl: FakeWS as unknown as typeof WebSocket, fetch: lookupFetch(), openWindow: openWindow as never });
  m.liveFactory = (x) => new LiveSession(x);
  return m;
}

async function toActive(m: SessionMachine, scope: 'current_tab' | 'all_tabs' = 'current_tab') {
  expect(await m.join('482193657710', ORIGIN)).toEqual({ ok: true, state: 'connecting' });
  const ws = FakeWS.last();
  ws.open();
  ws.recv({ t: 'desk.hello.ok', connectionId: 'c1', tokenId: UUID, tier: 'p2_extension', technician: { name: 'Asha' }, org: ORG, region: 'in-mum' });
  ws.recv({ t: 'knock.ok', sessionId: SID, resumeKey: 'rk-1', expiresAt: TS });
  ws.recv(created('consent_pending'));
  await tick(5);
  await handleUiCommand(m, { to: 'worker', t: 'ui.consent', decision: 'share', level: 'tab_control', scope, backstage: false, tabId: 1 });
  ws.recv({ t: 'consent.ok', sessionId: SID, state: 'active', consentState: 'granted', iceServers: [{ urls: 'stun:stun.example:3478' }] });
  await tick(20);
  return ws;
}

beforeEach(() => {
  FakeWS.reset();
  chrome = installChromeMock({ tabs: [makeTab(1, 'https://example.com/', { active: true }), makeTab(2, 'https://example.org/')] });
  openWindow = vi.fn(async () => 55);
});
afterEach(() => vi.useRealTimers());

describe('session state machine (sections 2.4, 3, 9.2)', () => {
  it('walks idle -> have_token -> connecting -> waiting -> knocked -> consent_pending -> active', async () => {
    const m = machine();
    expect(m.phase).toBe('idle');
    const joined = m.join('482193657710', ORIGIN);
    await joined;
    expect(m.phase).toBe('connecting');
    const ws = FakeWS.last();
    expect(ws.url).toBe('wss://in.indiansassist.example/signal');
    ws.open();
    const hello = ws.of('desk.hello')[0]!;
    expect(hello).toMatchObject({ token: '482193657710', client: { kind: 'extension', version: '0.2.0' } });
    expect(hello.resumeKey).toBeUndefined();
    ws.recv({ t: 'desk.hello.ok', connectionId: 'c1', tokenId: UUID, tier: 'p2_extension', technician: { name: 'Asha' }, org: ORG, region: 'in-mum' });
    expect(m.phase).toBe('waiting');
    expect(ws.of('desk.knock')).toHaveLength(1);
    ws.recv({ t: 'knock.ok', sessionId: SID, resumeKey: 'rk-1', expiresAt: TS });
    expect(m.phase).toBe('knocked');
    ws.recv(created('consent_pending'));
    await tick(5);
    expect(m.phase).toBe('consent_pending');
    const consentCalls = () => openWindow.mock.calls.filter((c) => String(c[0]).startsWith('consent.html'));
    expect(openWindow.mock.calls[0]![0]).toBe('popup.html'); // no side panel open: the join popup
    expect(consentCalls()).toEqual([[`consent.html?sessionId=${SID}`, 520, 820]]);
    ws.recv(created('consent_pending'));
    await tick(5);
    expect(consentCalls()).toHaveLength(1);
    expect(chrome.storage.session.data['ia.policyCache']).toBeDefined();
    expect(Object.keys(chrome.storage.local.data)).not.toContain('ia.session');
  });

  it('a second join while live answers busy (or already_connected for the same code)', async () => {
    const m = machine();
    await m.join('482193657710', ORIGIN);
    expect(await m.join('111111111116', ORIGIN)).toEqual({ ok: false, error: 'busy' });
    expect(await m.join('4821 9365 7710', ORIGIN)).toEqual({ ok: true, state: 'already_connected' });
  });

  it('consent sends desk.consent with the extension decision, capped to what can be honoured', async () => {
    const m = machine();
    const ws = await toActive(m);
    expect(ws.of('desk.consent')[0]).toMatchObject({ state: 'granted', surface: 'browser', extension: { level: 'tab_control', scope: 'current_tab', backstage: false } });
    expect(m.phase).toBe('active');
    expect(offscreenSent(chrome, 'pc.create')[0]).toMatchObject({ restart: false, relayAllowed: true });
    // The capture injection and the mirror.started attestation run asynchronously after consent.ok; under a
    // loaded parallel test run the fixed tick in toActive is not always enough, so wait for them.
    await vi.waitFor(() => expect(ws.of('desk.event').some((e) => e.action === 'mirror.started')).toBe(true), { timeout: 3000 });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: ['content.js'] });
    expect(chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('deep_control without the debugger permission is downgraded to in_page before the WS frame', async () => {
    const m = machine();
    await m.join('482193657710', ORIGIN);
    const ws = FakeWS.last();
    ws.open();
    ws.recv({ t: 'desk.hello.ok', connectionId: 'c1', tokenId: UUID, tier: 'p2_extension', technician: null, org: ORG, region: 'in-mum' });
    ws.recv({ t: 'knock.ok', sessionId: SID, resumeKey: 'rk', expiresAt: TS });
    ws.recv(created('consent_pending', { ...DEFAULT_EXTENSION_POLICY, allowAllTabs: false }));
    await tick(5);
    await handleUiCommand(m, { to: 'worker', t: 'ui.consent', decision: 'share', level: 'deep_control', scope: 'all_tabs', backstage: true, tabId: 1 });
    expect(ws.of('desk.consent')[0]).toMatchObject({ extension: { level: 'in_page', scope: 'current_tab', backstage: true } });
  });

  it('a chat from the Assist on ia.chat is shown once and acknowledged with chat.ack (A section 8.1)', async () => {
    const m = machine();
    await toActive(m);
    const chat = { t: 'chat', msgId: '00000000-0000-4000-8000-0000000000c1', from: 'assist', text: 'Hello', ts: 5 };
    await m.live!.onChannelMessage('ia.chat', chat);
    await m.live!.onChannelMessage('ia.chat', chat);
    const acks = offscreenSent(chrome, 'dc.send').filter((x) => x.label === 'ia.chat').map((x) => x.msg as Record<string, unknown>);
    expect(acks[0]).toMatchObject({ t: 'chat.ack', msgId: chat.msgId });
    expect((m.live as unknown as { chatLines: { msgId: string }[] }).chatLines.filter((l) => l.msgId === chat.msgId)).toHaveLength(1);
  });

  it('tabs.close with 50 ids writes exactly one tab.action desk.event', async () => {
    for (let i = 3; i < 53; i++) chrome.tabsStore.set(i, makeTab(i, `https://site${i}.example/`));
    const m = machine();
    const ws = await toActive(m, 'all_tabs');
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ id: 'ia-capture', excludeMatches: expect.arrayContaining(['*://accounts.google.com/*']) })]);
    const ids = Array.from({ length: 50 }, (_, i) => i + 3);
    await m.live!.control.handle({ t: 'ctl.req', id: 'close-1', op: 'tabs.close', args: { tabIds: ids }, ts: 1 });
    await tick(1200);
    const actions = ws.of('desk.event').filter((e) => e.action === 'tab.action');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.data).toMatchObject({ kind: 'tabs.close', tabIds: ids, ok: true, opId: opIdFor(SID, 'close-1') });
    const res = offscreenSent(chrome, 'dc.send').map((x) => x.msg as Record<string, unknown>).find((x) => x.t === 'ctl.res' && x.id === 'close-1');
    expect(res).toMatchObject({ ok: true, result: { closed: ids } });
  });

  it('Stop sharing flushes attestations before session.end and clears session storage', async () => {
    const m = machine();
    const ws = await toActive(m);
    await stopSharing(m, true);
    const order = ws.sent.map((x) => (x.t === 'desk.event' ? `desk.event:${x.action}` : x.t));
    const stoppedAt = order.indexOf('desk.event:mirror.stopped');
    expect(stoppedAt).toBeGreaterThan(-1);
    expect(order.indexOf('session.end')).toBeGreaterThan(stoppedAt);
    const ctrl = offscreenSent(chrome, 'dc.send').find((x) => (x.msg as { t: string }).t === 'stop.sharing');
    expect(ctrl).toBeDefined();
    expect(offscreenSent(chrome, 'pc.close')).toHaveLength(1);
    ws.recv({ t: 'session.ended', sessionId: SID, endReason: 'desk_stopped', endedAt: TS, startedAt: TS, durationMs: 1000, hashChainTail: null, assist: ASSIST, surface: 'browser', recordingStarted: false, reachedActive: true });
    await tick(5);
    expect(m.phase).toBe('ended');
    expect(m.receipt).toMatchObject({ sessionId: SID, endReason: 'desk_stopped', technician: 'Asha' });
    expect(chrome.storage.session.data['ia.session']).toBeUndefined();
    expect(chrome.storage.session.data['ia.policyCache']).toBeUndefined();
    expect(chrome.storage.local.data['ia.session']).toBeUndefined();
  });

  it('resumes an active session after a worker restart and rebuilds the PC on the resumed ice.refresh', async () => {
    const first = machine();
    await toActive(first);
    await tick(5);
    const persisted = chrome.storage.session.data['ia.session'] as Record<string, unknown>;
    expect(persisted.phase).toBe('active');
    chrome.runtimeSent.length = 0;
    const m = machine();
    await m.restore();
    expect(m.phase).toBe('active');
    const ws = FakeWS.last();
    ws.open();
    expect(ws.of('desk.hello')[0]).toMatchObject({ resumeKey: 'rk-1', client: { kind: 'extension' } });
    ws.recv({ t: 'desk.hello.ok', connectionId: 'c2', tokenId: UUID, tier: 'p2_extension', technician: null, org: ORG, region: 'in-mum', resume: { sessionId: SID, state: 'active', consentState: 'granted' } });
    ws.recv(created('active'));
    await tick(5);
    expect(openWindow.mock.calls.filter((c) => String(c[0]).startsWith('consent.html'))).toHaveLength(1); // no second consent
    ws.recv({ t: 'ice.refresh', sessionId: SID, iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }], iceTtl: 600, iceExpiresAt: TS });
    await tick(5);
    expect(offscreenSent(chrome, 'pc.create')[0]).toMatchObject({ restart: true });
  });
});
