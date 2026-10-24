/**
 * Phase A.2 section 8: the Desk consent text for the server recorder (U1), the receipt line (U3), the Assist
 * console's server recording badge (U4) and the Record button disabled by the org's recording policy.
 */
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthResponse, SessionEnded } from '@indiansassist/shared';
import { LiveConsole } from '../src/assist/console/LiveConsole';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { ConsentScreen } from '../src/desk/ConsentScreen';
import type { DeskController } from '../src/desk/deskController';
import { serverRecordingNotice } from '../src/desk/deskMedia';
import { DESK_INITIAL, type DeskSnapshot } from '../src/desk/deskTypes';
import { buildReceipt, receiptToText } from '../src/lib/receipt';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER } from './fakes';

const org = { displayName: 'Acme IT', accentColor: null, logoData: null };
const SERVER_TEXT =
  "This session will be recorded by Acme IT's server. The recording contains your shared screen and, if you turn it on, your microphone. " +
  'It is stored in India (Mumbai) and its fingerprint is written to a tamper-evident audit log.';
const BOTH_SUFFIX = 'Your technician may also record the session from their console.';

const created = (recordingMode?: string, tier = 'p1_browser') => ({
  t: 'session.created' as const,
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier,
  state: 'consent_pending',
  consentState: 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'Rahul' },
  org,
  polite: true,
  iceServers: [{ urls: ['stun:turn.example.com:3478'] }],
  iceTtl: 3600,
  iceExpiresAt: LATER,
  ...(recordingMode ? { recordingMode } : {}),
});

function consentSnap(recordingMode?: string): DeskSnapshot {
  return {
    ...DESK_INITIAL,
    phase: 'consent',
    sessionId: IDS.session,
    created: created(recordingMode) as unknown as DeskSnapshot['created'],
    hello: {
      t: 'desk.hello.ok',
      connectionId: 'c1',
      tokenId: IDS.token,
      tier: 'p1_browser',
      technician: { name: 'Anil K' },
      org,
      region: 'in-mum',
    } as unknown as DeskSnapshot['hello'],
  };
}

describe('Desk consent text (A.2 U1)', () => {
  const ctrl = {} as DeskController;

  it('mode server: the server recording paragraph inside the checklist, before the buttons', () => {
    render(<ConsentScreen ctrl={ctrl} snap={consentSnap('server')} />);
    const notice = screen.getByTestId('server-recording-notice');
    expect(notice.textContent).toBe(SERVER_TEXT);
    expect(notice.closest('section[aria-labelledby="checklist"]')).not.toBeNull();
    const share = screen.getByRole('button', { name: 'Share my screen' });
    expect(notice.compareDocumentPosition(share) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('mode both: appends the console recording sentence', () => {
    render(<ConsentScreen ctrl={ctrl} snap={consentSnap('both')} />);
    expect(screen.getByTestId('server-recording-notice').textContent).toBe(`${SERVER_TEXT} ${BOTH_SUFFIX}`);
  });

  it('modes assist_only, off and absent: no server recording sentence', () => {
    for (const mode of ['assist_only', 'off', undefined]) {
      const { unmount } = render(<ConsentScreen ctrl={ctrl} snap={consentSnap(mode)} />);
      expect(screen.queryByTestId('server-recording-notice')).toBeNull();
      expect(screen.queryByText(/recorded by/)).toBeNull();
      unmount();
    }
    expect(serverRecordingNotice('assist_only', 'Acme IT', 'in-mum')).toBeNull();
  });
});

describe('Desk receipt server recording (A.2 U3)', () => {
  const ended: SessionEnded = {
    t: 'session.ended',
    sessionId: IDS.session,
    endReason: 'assist_ended',
    endedAt: LATER,
    startedAt: ISO,
    durationMs: 1000,
    hashChainTail: null,
    assist: { id: IDS.user, name: 'Anil K' },
    surface: 'window',
    recordingStarted: false,
    reachedActive: true,
  };
  const build = (e: SessionEnded) =>
    buildReceipt({ ended: e, org: 'Acme IT', region: 'in-mum', files: [], recordingSeen: false });

  it('states yes from session.ended.serverRecording and no when absent', () => {
    const yes = build({ ...ended, serverRecording: true });
    expect(yes.serverRecording).toBe(true);
    expect(JSON.parse(JSON.stringify(yes))).toMatchObject({ serverRecording: true });
    expect(receiptToText(yes)).toContain('Server recording:  yes');
    expect(build(ended).serverRecording).toBe(false);
    expect(receiptToText(build(ended))).toContain('Server recording:  no');
  });
});

describe('Assist console server recording badge and Record button (A.2 U4)', () => {
  const me: AuthResponse = {
    user: {
      id: IDS.user,
      orgId: IDS.org,
      email: 'anil@acme.test',
      name: 'Anil K',
      role: 'technician',
      status: 'active',
      createdAt: ISO,
      lastLoginAt: ISO,
    },
    org: {
      id: IDS.org,
      name: 'Acme',
      slug: 'acme',
      dataRegion: 'in-mum',
      planTier: 'p1_browser',
      branding: { displayName: 'Acme IT' },
      createdAt: ISO,
    },
    seat: null,
  };
  const auth: AuthValue = {
    status: 'authenticated',
    me,
    error: null,
    setMe: () => undefined,
    refresh: () => undefined,
    logout: async () => undefined,
  };
  let ws: FakeWebSocket;
  let signal: SignalClient;

  beforeEach(() => {
    FakeWebSocket.reset();
    FakePeerConnection.reset();
    signal = new SignalClient({
      url: 'ws://x/signal',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      latencyPingMs: 0,
    });
    signal.connect();
    ws = FakeWebSocket.instances[0]!;
    ws.open();
  });

  afterEach(() => signal.close());

  function renderConsole(
    mode?: string,
    session?: { recordingMode?: 'off' | 'assist_only' | 'server' | 'both' | null; serverRecording?: boolean },
  ) {
    return render(
      <MemoryRouter>
        <StaticAuthProvider value={auth}>
          <LiveConsole
            sessionId={IDS.session}
            signal={signal}
            cached={created(mode) as never}
            helloReady
            deskLabel="Rahul"
            session={session}
          />
        </StaticAuthProvider>
      </MemoryRouter>,
    );
  }

  const badge = () => screen.getByTestId('server-recording-badge');

  it('mode server: waiting, then recording with a red dot, then stopped; console recording is disabled', async () => {
    renderConsole('server');
    expect(await screen.findByText('Server recording: waiting')).toBeTruthy();
    expect(badge().getAttribute('aria-live')).toBe('polite');
    const record = screen.getByRole('button', { name: 'Record' }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    expect(screen.getByText('Console recording is disabled by your organisation')).toBeTruthy();
    expect(record.getAttribute('aria-describedby')).toBe('console-rec-disabled');

    act(() => ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: true, source: 'server' }));
    expect(badge().textContent).toBe('Server recording');
    expect(screen.getByRole('img', { name: 'Recording in progress' })).toBeTruthy();
    // The Assist's own recording frames never change the server badge.
    act(() => ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: false }));
    expect(badge().textContent).toBe('Server recording');

    act(() => ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: false, source: 'server' }));
    expect(badge().textContent).toBe('Server recording stopped');
  });

  it('mode both: the badge shows and console recording stays allowed', async () => {
    renderConsole('both');
    expect(await screen.findByText('Server recording: waiting')).toBeTruthy();
    expect(screen.queryByText('Console recording is disabled by your organisation')).toBeNull();
  });

  it('mode assist_only or absent: no badge, console recording allowed', async () => {
    renderConsole(undefined);
    await screen.findByRole('button', { name: 'Record' });
    expect(badge().textContent).toBe('');
    expect(screen.queryByText('Console recording is disabled by your organisation')).toBeNull();
  });

  it('mode off: console recording disabled, no server badge', async () => {
    renderConsole('off');
    expect(await screen.findByText('Console recording is disabled by your organisation')).toBeTruthy();
    expect(badge().textContent).toBe('');
  });

  it('a REST Session with serverRecording true shows the recording badge on load', async () => {
    renderConsole(undefined, { recordingMode: 'server', serverRecording: true });
    expect(await screen.findByText('Server recording')).toBeTruthy();
    expect(screen.getByText('Console recording is disabled by your organisation')).toBeTruthy();
  });
});
