/**
 * The console no-screen state (Phase E section 7.4, stream linux): a native Desk whose capabilities lack `screen`
 * (a Linux Desk on Wayland) shows "The Desk cannot share its screen: Wayland session" in place of the video, as a
 * status region with a heading; the screen is rendered unchanged while capabilities are unknown or include `screen`;
 * in `AgentConsole` chat, files and playbooks stay and clipboard is greyed.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AgentCapabilities, AuthResponse } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { NoScreenSlot } from '../src/assist/console/EnterpriseSlots';
import { AgentConsole } from '../src/assist/console/agent/AgentConsole';
import { NO_SCREEN_DETAIL, NO_SCREEN_HINT_MAC, NO_SCREEN_TITLE, NO_SCREEN_TITLE_MAC, NoScreenState } from '../src/assist/console/agent/NoScreenState';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER } from './fakes';

const WAYLAND: AgentCapabilities = { monitors: 1, elevation: 'user', features: ['files', 'chat', 'playbooks'], encoders: ['vp8', 'vp9'], hwEncoder: false, interpreters: ['sh'] };
const X11: AgentCapabilities = {
  monitors: 2,
  elevation: 'user',
  features: ['screen', 'multi_monitor', 'input', 'input_text', 'clipboard', 'files', 'chat', 'playbooks', 'recorder'],
  encoders: ['vp8', 'vp9'],
  hwEncoder: false,
  interpreters: ['sh'],
};

const Screen = () => <div data-testid="the-screen">video</div>;

describe('NoScreenState', () => {
  it('renders the screen unchanged while capabilities are unknown', () => {
    const { rerender } = render(<NoScreenState capabilities={null}><Screen /></NoScreenState>);
    expect(screen.getByTestId('the-screen')).toBeTruthy();
    expect(screen.queryByText(NO_SCREEN_TITLE)).toBeNull();
    rerender(<NoScreenState capabilities={undefined}><Screen /></NoScreenState>);
    expect(screen.getByTestId('the-screen')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the screen unchanged when the Desk advertises screen (X11)', () => {
    render(<NoScreenState capabilities={X11}><Screen /></NoScreenState>);
    expect(screen.getByTestId('the-screen')).toBeTruthy();
    expect(screen.queryByText(NO_SCREEN_TITLE)).toBeNull();
  });

  it('replaces the screen with a status region and a heading when screen is missing (Wayland)', () => {
    render(<NoScreenState capabilities={WAYLAND}><Screen /></NoScreenState>);
    expect(screen.queryByTestId('the-screen')).toBeNull();
    const status = screen.getByRole('status', { name: NO_SCREEN_TITLE });
    expect(status).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'The Desk cannot share its screen: Wayland session' })).toBeTruthy();
    expect(status.textContent).toContain(NO_SCREEN_DETAIL);
    expect(status.textContent).toMatch(/Chat, files and playbooks still work/);
  });

  it('names the Screen Recording permission for a macOS Desk (zsh), never Wayland', () => {
    const MAC: AgentCapabilities = { ...WAYLAND, interpreters: ['zsh'] };
    render(<NoScreenState capabilities={MAC}><Screen /></NoScreenState>);
    const status = screen.getByRole('status', { name: NO_SCREEN_TITLE_MAC });
    expect(status.textContent).toContain(NO_SCREEN_HINT_MAC);
    expect(status.textContent).toContain(NO_SCREEN_DETAIL);
    expect(status.textContent).not.toMatch(/Wayland|Xorg/);
  });

  it('the foundation slot renders it', () => {
    const { rerender } = render(<NoScreenSlot capabilities={WAYLAND}><Screen /></NoScreenSlot>);
    expect(screen.getByText(NO_SCREEN_TITLE)).toBeTruthy();
    expect(screen.queryByTestId('the-screen')).toBeNull();
    rerender(<NoScreenSlot capabilities={X11}><Screen /></NoScreenSlot>);
    expect(screen.getByTestId('the-screen')).toBeTruthy();
    expect(screen.queryByText(NO_SCREEN_TITLE)).toBeNull();
  });
});

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p3_portable', branding: { displayName: 'Acme IT' }, createdAt: ISO },
  seat: null,
};
const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

function mount(capabilities: AgentCapabilities) {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  const signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  FakeWebSocket.instances[0]!.open();
  const created = {
    t: 'session.created', sessionId: IDS.session, tokenId: IDS.token, tier: 'p3_portable', state: 'consent_pending', consentState: 'pending',
    assist: { id: IDS.user, name: 'Anil K' }, desk: { label: 'Ubuntu laptop' }, org: { displayName: 'Acme IT', accentColor: null, logoData: null }, polite: true,
    agent: { playbooks: [{ id: IDS.other, name: 'Disk usage', description: 'df -h', interpreter: 'sh', requiresElevation: false, parameters: [], timeoutSec: 30, bodyHash: 'b'.repeat(64) }] },
    iceServers: [], iceTtl: 3600, iceExpiresAt: LATER,
  };
  render(
    <MemoryRouter>
      <StaticAuthProvider value={auth}>
        <AgentConsole
          sessionId={IDS.session}
          signal={signal}
          cached={created as never}
          helloReady
          deskLabel="Ubuntu laptop"
          capabilities={capabilities}
          deps={{ loadPolicy: async () => ({ requireSasConfirm: true }), report: async () => undefined, RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection }}
        />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
  return signal;
}

describe('AgentConsole with a Linux Desk', () => {
  it('Wayland: the no-screen state in place of the video; chat, files and playbooks stay; clipboard greyed', () => {
    const signal = mount(WAYLAND);
    expect(screen.getByRole('status', { name: NO_SCREEN_TITLE })).toBeTruthy();
    expect(screen.queryByText('Waiting for the user to share their screen.')).toBeNull();
    expect(screen.getByText('Disk usage')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Clipboard sync' })).toHaveProperty('disabled', true);
    signal.close();
  });

  it('X11: the screen as before, no no-screen state', () => {
    const signal = mount(X11);
    expect(screen.queryByText(NO_SCREEN_TITLE)).toBeNull();
    expect(screen.getByText('Waiting for the user to share their screen.')).toBeTruthy();
    signal.close();
  });
});
