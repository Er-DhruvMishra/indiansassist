/**
 * Phase F rule 8.4e in the live console: while the device reports its signed-in session locked
 * (`interactive.state === 'locked'`, read from `GET /devices/:id`), the console of a P4 session says
 * "The Desk's screen is locked", as the device page does; it says nothing while the session is unlocked.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_UNATTENDED_POLICY, type AgentCapabilities, type AuthResponse, type InteractiveState } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { AgentConsoleView } from '../src/assist/console/agent/AgentConsole';
import { AgentConsoleController } from '../src/assist/console/agent/agentConsoleController';
import { ScreenLockedNotice, unattendedInfo } from '../src/assist/console/agent/UnattendedBanner';
import { SCREEN_LOCKED_TEXT } from '../src/assist/fleet/fleetText';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER } from './fakes';

const CAPS: AgentCapabilities = { monitors: 1, elevation: 'user', features: ['screen', 'input', 'chat'], encoders: ['vp8'], hwEncoder: false, interpreters: ['sh'] };
const DEVICE_ID = '0b9f3c2e-7d41-4a8e-9c55-1f2e3d4c5b6a';
const policy = { ...DEFAULT_UNATTENDED_POLICY, mode: 'allow' as const };

const created = {
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier: 'p4_installed',
  state: 'consent_pending',
  consentState: 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'RECEPTION-01' },
  org: { displayName: 'Acme IT', accentColor: null, logoData: null },
  polite: true,
  agent: { playbooks: [] },
  iceServers: [],
  iceTtl: 3600,
  iceExpiresAt: LATER,
};

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.example.test', name: 'Anil K', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p4_installed', branding: { displayName: 'Acme IT' }, createdAt: ISO },
  seat: null,
};
const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

const state = (s: InteractiveState['state']): InteractiveState => ({ state: s, idleSec: s === 'locked' ? 30 : 0, at: 1, display: 'x11' });

let signal: SignalClient;
let ctrl: AgentConsoleController;

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  FakeWebSocket.instances[0]!.open();
  ctrl = new AgentConsoleController({
    signal,
    sessionId: IDS.session,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    report: async () => undefined,
    loadPolicy: async () => ({ requireSasConfirm: true }),
  });
  ctrl.start(created as never, true, CAPS);
});

afterEach(() => {
  ctrl.dispose();
  signal.close();
});

function renderConsole(interactive: InteractiveState | null) {
  const device = unattendedInfo({ deviceId: DEVICE_ID, deviceName: 'RECEPTION-01', unattended: true, policySnapshot: policy, approvedBy: 'policy', interactive });
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={auth}>
        <AgentConsoleView ctrl={ctrl} sessionId={IDS.session} deskLabel="RECEPTION-01" device={device} />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

describe("the live console says the Desk's screen is locked (rule 8.4e)", () => {
  it('folds the device state into the session info: locked only for `locked`', () => {
    const info = (i: InteractiveState | null) => unattendedInfo({ deviceId: DEVICE_ID, deviceName: 'x', unattended: true, interactive: i });
    expect(info(state('locked'))?.screenLocked).toBe(true);
    expect(info(state('active'))?.screenLocked).toBeUndefined();
    expect(info(state('none'))?.screenLocked).toBeUndefined();
    expect(info(null)?.screenLocked).toBeUndefined();
    // A P3 portable session has no device: nothing to say.
    expect(unattendedInfo({ deviceId: null, deviceName: 'x', unattended: null, interactive: state('locked') })).toBeUndefined();
  });

  it('shows the text while the device reports locked, as a polite status', () => {
    renderConsole(state('locked'));
    const notice = screen.getByTestId('screen-locked');
    expect(notice.textContent).toBe("The Desk's screen is locked");
    expect(notice.textContent).toBe(SCREEN_LOCKED_TEXT);
    expect(notice.getAttribute('role')).toBe('status');
  });

  it('shows nothing while the session is unlocked, and follows the device when it locks and unlocks', () => {
    const view = renderConsole(state('active'));
    expect(screen.queryByTestId('screen-locked')).toBeNull();
    const rerender = (i: InteractiveState) =>
      view.rerender(
        <MemoryRouter>
          <StaticAuthProvider value={auth}>
            <AgentConsoleView
              ctrl={ctrl}
              sessionId={IDS.session}
              deskLabel="RECEPTION-01"
              device={unattendedInfo({ deviceId: DEVICE_ID, deviceName: 'RECEPTION-01', unattended: true, policySnapshot: policy, interactive: i })}
            />
          </StaticAuthProvider>
        </MemoryRouter>,
      );
    rerender(state('locked'));
    expect(screen.getByTestId('screen-locked').textContent).toBe(SCREEN_LOCKED_TEXT);
    rerender(state('active'));
    expect(screen.queryByTestId('screen-locked')).toBeNull();
  });

  it('the notice on its own', () => {
    render(<ScreenLockedNotice />);
    expect(screen.getByRole('status').textContent).toBe(SCREEN_LOCKED_TEXT);
  });
});
