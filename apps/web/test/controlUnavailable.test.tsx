/**
 * Phase F section 9.4 (close-out): a Desk without `input` says why Control is unavailable. The text "This Desk cannot
 * take remote control" is visible beside the greyed Control button and is that button's accessible description, in
 * the desktop and the phone layouts: for the Wayland portal Desk (screen without input), for the no-screen Wayland
 * set, and never for a Desk that advertises `input`.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCapabilities, AuthResponse } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { AgentConsole } from '../src/assist/console/agent/AgentConsole';
import { AGENT_INITIAL, NO_INPUT_TEXT, controlBlocker, deskControlBlocker } from '../src/assist/console/agent/agentState';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER } from './fakes';

/** Section 9.4: the portal build on a Wayland session with the portal available. */
const PORTAL: AgentCapabilities = {
  monitors: 1,
  elevation: 'user',
  features: ['screen', 'files', 'chat', 'playbooks', 'recorder'],
  encoders: ['vp8', 'vp9'],
  hwEncoder: false,
  interpreters: ['sh'],
};
/** E section 7.5: a Wayland session with no portal (no screen, no input). */
const WAYLAND: AgentCapabilities = { monitors: 1, elevation: 'user', features: ['files', 'chat', 'playbooks'], encoders: ['vp8', 'vp9'], hwEncoder: false, interpreters: ['sh'] };
/** E section 7.5: the X11 set (input included). */
const X11: AgentCapabilities = {
  monitors: 2,
  elevation: 'user',
  features: ['screen', 'multi_monitor', 'input', 'input_text', 'clipboard', 'files', 'chat', 'playbooks', 'recorder'],
  encoders: ['vp8', 'vp9'],
  hwEncoder: false,
  interpreters: ['sh'],
};

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p3_portable', branding: { displayName: 'Acme IT' }, createdAt: ISO },
  seat: null,
};
const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

const realSize = { w: window.innerWidth, h: window.innerHeight };
function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

afterEach(() => {
  cleanup();
  setViewport(realSize.w, realSize.h);
});

function mount(capabilities: AgentCapabilities) {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  const signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  FakeWebSocket.instances[0]!.open();
  const created = {
    t: 'session.created', sessionId: IDS.session, tokenId: IDS.token, tier: 'p3_portable', state: 'consent_pending', consentState: 'pending',
    assist: { id: IDS.user, name: 'Anil K' }, desk: { label: 'Fedora laptop' }, org: { displayName: 'Acme IT', accentColor: null, logoData: null }, polite: true,
    agent: { playbooks: [] }, iceServers: [], iceTtl: 3600, iceExpiresAt: LATER,
  };
  render(
    <MemoryRouter>
      <StaticAuthProvider value={auth}>
        <AgentConsole
          sessionId={IDS.session}
          signal={signal}
          cached={created as never}
          helloReady
          deskLabel="Fedora laptop"
          capabilities={capabilities}
          deps={{ loadPolicy: async () => ({ requireSasConfirm: true }), report: async () => undefined, RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection }}
        />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
  return signal;
}

function expectUnavailable() {
  const control = screen.getByRole('button', { name: 'Control', description: NO_INPUT_TEXT });
  expect(control).toHaveProperty('disabled', true);
  expect(screen.getByTestId('control-unavailable').textContent).toBe(NO_INPUT_TEXT);
  expect(screen.getByRole('button', { name: 'Elevated' })).toHaveProperty('disabled', true);
}

describe('the view-only Desk text (section 9.4)', () => {
  it('deskControlBlocker: the text for a Desk without input, nothing for unknown capabilities or a full set', () => {
    expect(deskControlBlocker({ capabilities: PORTAL })).toBe('This Desk cannot take remote control');
    expect(deskControlBlocker({ capabilities: WAYLAND })).toBe(NO_INPUT_TEXT);
    expect(deskControlBlocker({ capabilities: X11 })).toBeNull();
    expect(deskControlBlocker({ capabilities: null })).toBeNull();
    const sec = { ...AGENT_INITIAL.sec, state: 'established' as const };
    expect(controlBlocker({ ...AGENT_INITIAL, sec, capabilities: PORTAL })).toBe(NO_INPUT_TEXT);
  });

  it('portal Desk (screen without input), desktop layout: the visible text describes the greyed Control', () => {
    const signal = mount(PORTAL);
    expectUnavailable();
    signal.close();
  });

  it('portal Desk, phone layout: the same text in the View sheet and in place of the keys hint', () => {
    setViewport(393, 852);
    const signal = mount(PORTAL);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toContain('Keys');
    expectUnavailable();
    expect(screen.queryByText('Take control to type on the remote computer.')).toBeNull();
    expect(screen.getAllByText(NO_INPUT_TEXT).length).toBe(2);
    signal.close();
  });

  it('no-screen Wayland Desk: the same text', () => {
    const signal = mount(WAYLAND);
    expectUnavailable();
    signal.close();
  });

  it('a full set (input advertised): no text and no description', () => {
    const signal = mount(X11);
    expect(screen.queryByText(NO_INPUT_TEXT)).toBeNull();
    expect(screen.queryByTestId('control-unavailable')).toBeNull();
    expect(screen.getByRole('button', { name: 'Control' }).getAttribute('aria-describedby')).toBeNull();
    signal.close();
  });
});
