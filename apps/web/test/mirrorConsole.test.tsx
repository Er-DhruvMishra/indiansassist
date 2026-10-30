/**
 * P2 console (Phase B 10.1, 3.2, 3.5, 6): tab strip states and the "User switched" chip, consent-level gating of
 * the input mode toggle and the tab / backstage controls, the level request with a reason, the bring-to-front
 * confirmation, and the P2 resume rule (keep the link on `desk.reconnected { active }`, rebuild the PC on a
 * restart offer while keeping the recorder).
 */
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthResponse, TabInfo } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { MirrorConsoleView } from '../src/assist/console/mirror/MirrorConsole';
import { MirrorConsoleController } from '../src/assist/console/mirror/mirrorController';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER } from './fakes';

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p2_extension', branding: { displayName: 'Acme IT' }, createdAt: ISO },
  seat: null,
};
const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

const created = (state: 'consent_pending' | 'active') => ({
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier: 'p2_extension',
  state,
  consentState: state === 'active' ? 'granted' : 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'Rahul' },
  org: { displayName: 'Acme IT', accentColor: null, logoData: null },
  polite: true,
  iceServers: [{ urls: ['stun:turn.example.com:3478'] }],
  iceTtl: 3600,
  iceExpiresAt: LATER,
});

function tab(tabId: number, over: Partial<TabInfo> = {}): TabInfo {
  return { tabId, windowId: 1, index: tabId, title: `Tab ${tabId}`, url: `https://site${tabId}.example/`, favicon: null, active: false, pinned: false, muted: false, audible: false, groupId: -1, status: 'complete', mirrored: 'yes', backstage: false, createdByAssist: false, revealed: 'none', discarded: false, ...over };
}

let ws: FakeWebSocket;
let signal: SignalClient;
let ctrl: MirrorConsoleController;
let reports: unknown[];

/** A Desk-created data channel delivered to the console's fake connection (`ondatachannel`). */
class DeskChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly label: string) {
    super();
  }
  send(): void {}
  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  deliver(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

function deskChannel(pc: FakePeerConnection, label: string): DeskChannel {
  const ch = new DeskChannel(label);
  (pc as unknown as { ondatachannel: ((e: { channel: DeskChannel }) => void) | null }).ondatachannel?.({ channel: ch });
  return ch;
}

function grant(level: string, backstage = false) {
  act(() => ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'browser', level, scope: 'current_tab', backstage }));
}

function tabs(list: TabInfo[], activeTabId: number | null, hiddenCount = 0) {
  act(() => ctrl.plane.mirrorJson({ t: 'mirror.tabs', tabs: list, hiddenCount, activeTabId, focusedTabId: list[0]?.tabId ?? null, ts: Date.now() }));
}

function relayed(): { op: string; args: Record<string, unknown> }[] {
  return ws.ofType('control.relay').map((m) => {
    const { op, args } = (m as unknown as { msg: { op: string; args: Record<string, unknown> } }).msg;
    return { op, args };
  });
}

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  reports = [];
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  ws = FakeWebSocket.instances[0]!;
  ws.open();
  ctrl = new MirrorConsoleController({
    signal,
    sessionId: IDS.session,
    assist: { id: IDS.user, name: 'Anil K' },
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    report: async (r) => void reports.push(r),
  });
  ctrl.start(created('consent_pending') as never, true);
  render(
    <MemoryRouter>
      <StaticAuthProvider value={auth}>
        <MirrorConsoleView ctrl={ctrl} sessionId={IDS.session} signal={signal} deskLabel="Rahul" />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
});

afterEach(() => {
  ctrl.dispose();
  signal.close();
});

describe('MirrorConsole', () => {
  it('waits for consent, then shows the tab strip with state badges, "+N not shared" and the sandboxed frame', () => {
    expect(screen.getByText(/choosing what to share/)).toBeTruthy();
    grant('tab_control');
    tabs([tab(1, { active: true }), tab(2, { mirrored: 'paused' }), tab(3, { backstage: true, createdByAssist: true }), tab(4, { mirrored: 'denied', title: null, url: null })], 1, 3);
    const strip = screen.getByRole('tablist', { name: 'Shared tabs' });
    expect(within(screen.getByTestId('tab-2')).getByText('paused')).toBeTruthy();
    expect(within(screen.getByTestId('tab-3')).getByText('background')).toBeTruthy();
    expect(within(screen.getByTestId('tab-3')).getByText('opened by you')).toBeTruthy();
    expect(within(screen.getByTestId('tab-4')).getByText('protected')).toBeTruthy();
    expect(within(strip).getByText('+3 not shared')).toBeTruthy();
    expect(screen.getByTestId('tab-1').getAttribute('aria-selected')).toBe('true');
    const frame = screen.getByTestId('replayer-frame');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')).toBe('/replayer.html');
    expect(screen.getByText('Waiting for snapshot')).toBeTruthy();
  });

  it('raises "User switched to ..." when the Desk changes tabs and Follow focuses it', async () => {
    const user = userEvent.setup();
    grant('tab_control');
    tabs([tab(1), tab(2)], 1);
    tabs([tab(1), tab(2)], 2);
    expect(screen.getByText('User switched to Tab 2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Follow' }));
    expect(screen.queryByText('User switched to Tab 2')).toBeNull();
    expect(screen.getByTestId('tab-2').getAttribute('aria-selected')).toBe('true');
    expect(relayed().at(-1)).toEqual({ op: 'mirror.focus', args: { tabId: 2 } });
  });

  it('greys controls by the granted level: view disables tab control, tab_control asks for in-page', async () => {
    grant('view');
    tabs([tab(1)], 1);
    const group = screen.getByRole('radiogroup', { name: 'Input mode' });
    const seg = (name: RegExp) => within(group).getByRole('radio', { name });
    expect(seg(/^View/).getAttribute('data-state')).toBe('selected');
    expect(seg(/^Tab control/).getAttribute('data-state')).toBe('ask');
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Reload' }).getAttribute('title')).toMatch(/Switch and open tabs/);
    expect((screen.getByRole('button', { name: 'Open background tab' }) as HTMLButtonElement).disabled).toBe(true);

    grant('tab_control');
    expect(seg(/^Tab control/).getAttribute('data-state')).toBe('available');
    expect(seg(/^In-page/).getAttribute('data-state')).toBe('ask');
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('backstage-blocked').textContent).toBe('The user has not allowed background tabs.');

    grant('in_page', true);
    expect(seg(/^In-page/).getAttribute('data-state')).toBe('available');
    expect(seg(/^Deep control/).getAttribute('data-state')).toBe('ask');
    expect(screen.queryByTestId('backstage-blocked')).toBeNull();
  });

  it('asks for a higher level with a required reason and reports level.requested', async () => {
    const user = userEvent.setup();
    grant('tab_control');
    tabs([tab(1)], 1);
    await user.click(screen.getByRole('radio', { name: /^In-page/ }));
    const dialog = screen.getByRole('dialog', { name: 'Ask the user for more control' });
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(within(dialog).getByText('Enter a reason.')).toBeTruthy();
    await user.type(within(dialog).getByLabelText('Reason'), 'Need to fix the proxy setting');
    await user.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(relayed().at(-1)).toEqual({ op: 'level.request', args: { level: 'in_page', reason: 'Need to fix the proxy setting' } });
    await vi.waitFor(() => expect(reports).toContainEqual({ action: 'level.requested', data: { level: 'in_page', opId: expect.stringMatching(/^[0-9a-f]{16}$/) }, reason: 'Need to fix the proxy setting' }));
    expect(screen.getByText(/Waiting for the user to answer/)).toBeTruthy();
  });

  it('drops replayer input below in-page and forwards it once the level and mode allow', () => {
    grant('tab_control');
    tabs([tab(1)], 1);
    const click = { t: 'rp.pointer', tabId: 1, kind: 'click', nodeId: 5, nx: 0.5, ny: 0.5, vx: 0.2, vy: 0.3, button: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } as const;
    const frameMsg = (ctrl.plane as unknown as { onFrame: (m: unknown) => void }).onFrame.bind(ctrl.plane);
    act(() => frameMsg(click));
    expect(relayed().filter((m) => m.op === 'input.pointer')).toHaveLength(0);
    grant('in_page');
    act(() => ctrl.plane.setInputMode('in_page'));
    act(() => frameMsg(click));
    expect(relayed().filter((m) => m.op === 'input.pointer')).toEqual([{ op: 'input.pointer', args: { tabId: 1, kind: 'click', nodeId: 5, nx: 0.5, ny: 0.5, vx: 0.2, vy: 0.3, modifiers: click.modifiers } }]);
  });

  it('confirms before bringing a background tab to the front', async () => {
    const user = userEvent.setup();
    grant('tab_control', true);
    tabs([tab(1), tab(7, { backstage: true, createdByAssist: true, title: 'Settings' })], 1);
    await user.click(screen.getByRole('button', { name: 'Bring to front' }));
    const dialog = screen.getByRole('dialog', { name: 'Bring this tab to the front?' });
    expect(relayed().some((m) => m.op === 'backstage.exit')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Bring to front' }));
    expect(relayed().at(-1)).toEqual({ op: 'backstage.exit', args: { tabId: 7, action: 'bring_to_front' } });
  });
});

describe('P2 orderly end (A section 7.4 hard rule 2)', () => {
  it('consent.revoked on ia.ctrl tears down at once and waits for session.ended', () => {
    grant('tab_control');
    const pc = FakePeerConnection.instances[0]!;
    act(() => pc.setConnectionState('connected'));
    const ch = deskChannel(pc, 'ia.ctrl');
    act(() => ch.deliver({ t: 'consent.revoked', ts: 1 }));
    expect(pc.closed).toBe(true);
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(ctrl.snapshot.notice).toMatch(/revoked consent/);
    act(() => pc.setConnectionState('failed'));
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(ws.ofType('session.end')).toHaveLength(0);
    act(() => ws.receive({ t: 'session.ended', sessionId: IDS.session, endReason: 'consent_revoked', endedAt: LATER, startedAt: LATER, durationMs: 0, hashChainTail: null, assist: { id: IDS.user, name: 'Anil K' }, surface: 'browser', recordingStarted: false, reachedActive: true }));
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended?.endReason).toBe('consent_revoked');
  });
});

describe('P2 resume rule (Phase B 3.5)', () => {
  it('keeps the link on desk.reconnected { active } and rebuilds only the PC on a restart offer, keeping the recorder', async () => {
    grant('tab_control');
    expect(FakePeerConnection.instances).toHaveLength(1);
    const first = FakePeerConnection.instances[0]!;
    act(() => first.setConnectionState('connected'));
    act(() => ctrl.startRecording());
    expect(ctrl.snapshot.recording).toBe('recording');
    act(() => ws.receive({ t: 'desk.reconnected', sessionId: IDS.session, state: 'active', consentState: 'granted' }));
    expect(first.closed).toBe(false);
    expect(ctrl.snapshot.stale).toBe(true);
    expect(ctrl.snapshot.phase).not.toBe('waiting_consent');

    act(() => ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 new-pc', restart: true }));
    expect(first.closed).toBe(true);
    expect(FakePeerConnection.instances).toHaveLength(2);
    await vi.waitFor(() => expect(ws.ofType('webrtc.answer')).toHaveLength(1));
    expect(ctrl.snapshot.recording).toBe('recording');
    expect(ctrl.rec.recorder?.text()).toContain('"reconnect"');

    // An ordinary renegotiation offer on a connected PC does not rebuild.
    act(() => FakePeerConnection.instances[1]!.setConnectionState('connected'));
    act(() => ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 voice' }));
    expect(FakePeerConnection.instances).toHaveLength(2);
  });
});
