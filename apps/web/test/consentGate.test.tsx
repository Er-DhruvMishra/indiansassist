/**
 * Consent gate (contracts section 12.1 D1 / D2, section 7.7): the Desk room never calls getDisplayMedia
 * before the consent screen (after session.created) and the explicit Share click; the peer connection is
 * built only after consent.ok; Stop sharing performs hard rule 2.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@indiansassist/shared';
import { RoomLayout } from '../src/desk/RoomLayout';
import { FakePeerConnection, FakeWebSocket, IDS, LATER, fakeStream, fakeTrack } from './fakes';

const COMPACT = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const org = { displayName: 'Acme IT', accentColor: null, logoData: null };

let gdm: ReturnType<typeof vi.fn>;
let screenTrack: ReturnType<typeof fakeTrack>;

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  sessionStorage.setItem(STORAGE_KEYS.joinToken, COMPACT);
  sessionStorage.setItem(STORAGE_KEYS.joinSignal, 'ws://localhost:4000/signal');
  screenTrack = fakeTrack('video', 'window');
  gdm = vi.fn().mockResolvedValue(fakeStream([screenTrack]));
});

afterEach(() => {
  vi.useRealTimers();
});

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/room/new']}>
      <Routes>
        <Route
          path="/room"
          element={
            <RoomLayout
              testDeps={{
                WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
                RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
                getDisplayMedia: gdm as unknown as (o: DisplayMediaStreamOptions) => Promise<MediaStream>,
                pollMs: 600000,
              }}
            />
          }
        >
          <Route path="new" element={null} />
          <Route path=":sessionId" element={null} />
        </Route>
        <Route path="/join" element={<p>JOIN PAGE</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function socket(): Promise<FakeWebSocket> {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
}

async function toConsentScreen(): Promise<FakeWebSocket> {
  renderRoom();
  const ws = await socket();
  act(() => ws.open());
  expect(ws.ofType('desk.hello')[0]).toMatchObject({ token: COMPACT });
  act(() =>
    ws.receive({ t: 'desk.hello.ok', connectionId: 'c1', tokenId: IDS.token, tier: 'p1_browser', technician: { name: 'Priya S' }, org, region: 'in-mum' }),
  );
  expect(ws.ofType('desk.knock')).toHaveLength(1);
  expect(await screen.findByText('Waiting for Priya S to accept')).toBeTruthy();
  expect(gdm).not.toHaveBeenCalled();

  act(() => ws.receive({ t: 'knock.ok', sessionId: IDS.session, resumeKey: 'rk-secret', expiresAt: LATER }));
  expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.roomResume)!)).toEqual({ sessionId: IDS.session, resumeKey: 'rk-secret' });
  expect(gdm).not.toHaveBeenCalled();

  act(() =>
    ws.receive({
      t: 'session.created',
      sessionId: IDS.session,
      tokenId: IDS.token,
      tier: 'p1_browser',
      state: 'consent_pending',
      consentState: 'pending',
      assist: { id: IDS.user, name: 'Anil K' },
      desk: { label: 'Desk' },
      org,
      polite: false,
    }),
  );
  // D1: the consent screen names the accepting technician, not the token creator.
  expect(await screen.findByText('Anil K from Acme IT is asking to see your screen')).toBeTruthy();
  return ws;
}

describe('Desk consent gate', () => {
  it('never calls getDisplayMedia before consent and builds the peer only after consent.ok', async () => {
    const user = userEvent.setup();
    const ws = await toConsentScreen();
    expect(gdm).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances).toHaveLength(0);

    const share = screen.getByRole('button', { name: 'Share my screen' }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    await user.click(share);
    expect(gdm).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText('I have closed or hidden anything private'));
    expect(share.disabled).toBe(false);
    expect(ws.ofType('desk.consent')).toHaveLength(0);
    await user.click(share);

    expect(gdm).toHaveBeenCalledTimes(1);
    expect(gdm.mock.calls[0]![0]).toMatchObject({ audio: false, monitorTypeSurfaces: 'exclude', selfBrowserSurface: 'exclude' });
    await waitFor(() => expect(ws.ofType('desk.consent')).toEqual([expect.objectContaining({ state: 'granted', surface: 'window' })]));
    expect(FakePeerConnection.instances).toHaveLength(0);

    act(() => ws.receive({ t: 'consent.ok', sessionId: IDS.session, state: 'active', consentState: 'granted', iceServers: [] }));
    await screen.findByText('You are sharing your screen with Anil K (Acme IT)');
    expect(FakePeerConnection.instances).toHaveLength(1);
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.channels.map((c) => c.label)).toEqual(['ia.chat', 'ia.annot', 'ia.file', 'ia.ctrl']);
    expect(pc.tracks).toContain(screenTrack);

    // D4: Stop sharing => hard rule 2 (tracks stopped, connection closed) then WS session.end.
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));
    expect(screenTrack.stop).toHaveBeenCalled();
    expect(pc.closed).toBe(true);
    expect(ws.ofType('session.end')).toEqual([expect.objectContaining({ sessionId: IDS.session })]);

    act(() =>
      ws.receive({
        t: 'session.ended',
        sessionId: IDS.session,
        endReason: 'desk_stopped',
        endedAt: LATER,
        startedAt: '2026-10-23T23:50:00.000Z',
        durationMs: 539000,
        hashChainTail: 'a'.repeat(64),
        assist: { id: IDS.user, name: 'Anil K' },
        surface: 'window',
        recordingStarted: false,
        reachedActive: true,
      }),
    );
    expect(await screen.findByText('Session ended: your consent receipt')).toBeTruthy();
    expect(screen.getByText('A single application window')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download receipt (text)' })).toBeTruthy();
    expect(sessionStorage.getItem(STORAGE_KEYS.roomResume)).toBeNull();
  });

  it('a cancelled picker sends nothing and stays on the consent screen', async () => {
    gdm.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    const user = userEvent.setup();
    const ws = await toConsentScreen();
    await user.click(screen.getByLabelText('I have closed or hidden anything private'));
    await user.click(screen.getByRole('button', { name: 'Share my screen' }));
    expect(gdm).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Nothing was shared/)).toBeTruthy();
    expect(ws.ofType('desk.consent')).toHaveLength(0);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Share my screen' })).toBeTruthy();
  });

  it('Decline revokes without ever opening the picker', async () => {
    const user = userEvent.setup();
    const ws = await toConsentScreen();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    expect(ws.ofType('desk.consent')).toEqual([expect.objectContaining({ state: 'revoked' })]);
    expect(gdm).not.toHaveBeenCalled();
  });

  it('a held knock waits without prompting, and a denial offers Try again', async () => {
    const user = userEvent.setup();
    renderRoom();
    const ws = await socket();
    act(() => ws.open());
    act(() => ws.receive({ t: 'desk.hello.ok', connectionId: 'c1', tokenId: IDS.token, tier: 'p1_browser', technician: null, org, region: 'in-mum' }));
    act(() => ws.receive({ t: 'knock.held', technicianOnline: false }));
    expect(await screen.findByText('Your technician is not online yet, this page keeps trying.')).toBeTruthy();
    expect(screen.getByText('Waiting for your technician')).toBeTruthy();
    act(() => ws.receive({ t: 'knock.ok', sessionId: IDS.session, resumeKey: 'rk', expiresAt: LATER }));
    act(() =>
      ws.receive({
        t: 'session.ended',
        sessionId: IDS.session,
        endReason: 'denied',
        endedAt: LATER,
        startedAt: null,
        durationMs: null,
        hashChainTail: null,
        assist: { id: IDS.user, name: 'Anil K' },
        surface: null,
        recordingStarted: false,
        reachedActive: false,
      }),
    );
    expect(await screen.findByText('Your technician declined the request.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(ws.ofType('desk.knock')).toHaveLength(2);
    expect(gdm).not.toHaveBeenCalled();
  });

  it('drops inbound frames that fail the shared schema', async () => {
    renderRoom();
    const ws = await socket();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => ws.open());
    act(() => ws.receive({ t: 'session.created', sessionId: 'not-a-uuid' }));
    act(() => ws.receive({ t: 'totally.unknown' }));
    expect(warn).toHaveBeenCalled();
    expect(screen.queryByText(/is asking to see your screen/)).toBeNull();
    expect(gdm).not.toHaveBeenCalled();
  });

  it('redirects to /join when the room has no stored token', async () => {
    sessionStorage.clear();
    renderRoom();
    expect(await screen.findByText('JOIN PAGE')).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
