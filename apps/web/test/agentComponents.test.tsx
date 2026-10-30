/**
 * P3 console components (section 13.4): AgentConsole mount, MonitorPicker, InputModeToggle with the SAS gate,
 * SasConfirmDialog, ElevationDialog, PlaybookPanel (live output, 409 text, elevation gate) and AgentStats.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthResponse, MonitorInfo, PlaybookManifest } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { AgentConsole } from '../src/assist/console/agent/AgentConsole';
import { AgentStats } from '../src/assist/console/agent/AgentStats';
import { ElevationDialog, UAC_WARNING } from '../src/assist/console/agent/ElevationDialog';
import { InputModeToggle } from '../src/assist/console/agent/InputModeToggle';
import { MonitorPicker } from '../src/assist/console/agent/MonitorPicker';
import { PlaybookPanel } from '../src/assist/console/agent/PlaybookPanel';
import { SasConfirmDialog } from '../src/assist/console/agent/SasConfirmDialog';
import { PLAYBOOK_CHANGED_TEXT } from '../src/assist/console/agent/agentPlaybooks';
import { SAS_GATE_INITIAL } from '../src/assist/console/agent/sasGate';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER } from './fakes';

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p3_portable', branding: { displayName: 'Acme IT' }, createdAt: ISO },
  seat: null,
};
const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

const MON: MonitorInfo[] = [
  { id: 1, name: 'DELL', primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, mid: '0' },
  { id: 2, name: 'LG', primary: false, x: 1920, y: 0, width: 2560, height: 1440, scale: 1.5, mid: '1' },
];

afterEach(() => vi.useRealTimers());

describe('AgentConsole', () => {
  it('mounts for a p3 session: securing state, playbooks from session.created, security code after the handshake', () => {
    FakeWebSocket.reset();
    FakePeerConnection.reset();
    const signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
    signal.connect();
    FakeWebSocket.instances[0]!.open();
    const created = {
      t: 'session.created', sessionId: IDS.session, tokenId: IDS.token, tier: 'p3_portable', state: 'consent_pending', consentState: 'pending',
      assist: { id: IDS.user, name: 'Anil K' }, desk: { label: 'Rahul' }, org: { displayName: 'Acme IT', accentColor: null, logoData: null }, polite: true,
      agent: { playbooks: [{ id: IDS.other, name: 'Flush DNS', description: 'ipconfig', interpreter: 'cmd', requiresElevation: false, parameters: [], timeoutSec: 30, bodyHash: 'b'.repeat(64) }] },
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
            deskLabel="Rahul"
            capabilities={{ monitors: 2, elevation: 'user', features: ['screen', 'playbooks', 'elevation'], encoders: ['vp8'], hwEncoder: false, interpreters: ['cmd'] }}
            deps={{ loadPolicy: async () => ({ requireSasConfirm: true }), report: async () => undefined, RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection }}
          />
        </StaticAuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Session with Rahul' })).toBeTruthy();
    expect(screen.getByText(/Waiting for consent/)).toBeTruthy();
    expect(screen.getByText('Flush DNS')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Control' })).toHaveProperty('disabled', true);
    act(() => {
      FakeWebSocket.instances[0]!.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0' });
    });
    expect(screen.getAllByText(/Securing the connection/).length).toBeGreaterThan(0);
    expect(FakePeerConnection.instances).toHaveLength(1);
    signal.close();
  });
});

describe('MonitorPicker', () => {
  it('selects one monitor or the mosaic; greyed with a single monitor', async () => {
    const onView = vi.fn();
    const { rerender } = render(<MonitorPicker monitors={MON} selected={[1]} viewed={1} floorMode={false} onView={onView} />);
    expect(screen.getByRole('button', { name: /DELL/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/2560 x 1440, scale 1.5/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /LG/ }));
    await userEvent.click(screen.getByRole('button', { name: 'All monitors' }));
    expect(onView.mock.calls).toEqual([[2], ['all']]);
    rerender(<MonitorPicker monitors={[MON[0]!]} selected={[1]} viewed={1} floorMode={false} onView={onView} />);
    expect(screen.getByRole('button', { name: 'All monitors' })).toHaveProperty('disabled', true);
  });
});

describe('InputModeToggle', () => {
  const base = { tier: 'p3_portable' as const, chip: 'Control', mode: 'view' as const, secured: true, canElevate: true, onMode: vi.fn(), onAskControl: vi.fn(), onElevate: vi.fn(), onConfirmSas: vi.fn() };
  it('Control is greyed until the code is confirmed, and for a view-only grant offers Ask the user', async () => {
    const { rerender } = render(<InputModeToggle {...base} level="control" sasConfirmed={false} />);
    expect(screen.getByRole('button', { name: 'Control' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm security code' }));
    expect(base.onConfirmSas).toHaveBeenCalled();
    rerender(<InputModeToggle {...base} level="control" sasConfirmed />);
    expect(screen.getByRole('button', { name: 'Control' })).toHaveProperty('disabled', false);
    rerender(<InputModeToggle {...base} level="view" sasConfirmed />);
    expect(screen.getByRole('button', { name: 'Control' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Ask the user' }));
    await userEvent.type(screen.getByLabelText('Reason shown to the user'), 'fix the printer');
    await userEvent.click(screen.getAllByRole('button', { name: 'Ask the user' }).at(-1)!);
    expect(base.onAskControl).toHaveBeenCalledWith('fix the printer');
  });
  it('a P2 level never enables Control (family rule)', () => {
    render(<InputModeToggle {...base} level="deep_control" sasConfirmed />);
    expect(screen.getByRole('button', { name: 'Control' })).toHaveProperty('disabled', true);
  });
});

describe('SasConfirmDialog', () => {
  it('reports wrong codes, locks after three, and shows Skip only when not required', async () => {
    const results = [
      { result: 'wrong' as const, state: SAS_GATE_INITIAL, attemptsLeft: 2 },
      { result: 'locked' as const, state: { attempts: 3, lockedUntil: Date.now() + 10_000 }, attemptsLeft: 0 },
    ];
    const onConfirm = vi.fn(() => results.shift()!);
    const { rerender } = render(<SasConfirmDialog open gen={0} requireConfirm onConfirm={onConfirm} onSkip={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    const input = screen.getByLabelText('Security code the user reads out');
    await userEvent.type(input, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm code' }));
    expect(screen.getByText(/2 attempts left/)).toBeTruthy();
    await userEvent.type(input, '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm code' }));
    expect(screen.getByText(/Wait 10 seconds/)).toBeTruthy();
    expect(screen.getByLabelText('Security code the user reads out')).toHaveProperty('disabled', true);
    const onSkip = vi.fn();
    rerender(<SasConfirmDialog open gen={1} requireConfirm={false} onConfirm={onConfirm} onSkip={onSkip} onClose={vi.fn()} />);
    expect(screen.getByText(/the code is new/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalled();
  });
});

describe('ElevationDialog', () => {
  it('needs a reason, warns about UAC and shows the live state', async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<ElevationDialog open state={null} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(screen.getByText(UAC_WARNING)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request elevation' })).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText('Why do you need administrator rights?'), 'restart the spooler');
    await userEvent.click(screen.getByRole('button', { name: 'Request elevation' }));
    expect(onSubmit).toHaveBeenCalledWith('restart the spooler');
    rerender(<ElevationDialog open state={{ state: 'denied', cause: 'uac_cancelled' }} onSubmit={onSubmit} onClose={vi.fn()} />);
    expect(screen.getByText(/refused the request\. \(uac cancelled\)/)).toBeTruthy();
  });
});

describe('PlaybookPanel', () => {
  const pbs: PlaybookManifest[] = [
    { id: 'a', name: 'Ping host', description: '', interpreter: 'powershell', requiresElevation: false, timeoutSec: 30, bodyHash: 'h', parameters: [{ name: 'host', label: 'Host', type: 'string', required: true, pattern: '.+' }] },
    { id: 'b', name: 'Restart Print Spooler', description: '', interpreter: 'powershell', requiresElevation: true, timeoutSec: 60, bodyHash: 'h', parameters: [] },
  ];
  it('runs with typed args, shows the 409 text, disables elevation playbooks, renders live output', async () => {
    const onRun = vi.fn().mockResolvedValueOnce(PLAYBOOK_CHANGED_TEXT).mockResolvedValue(null);
    const runs = [{ runId: 'r1', playbookId: 'a', name: 'Ping host', stdout: 'Reply from 1.1.1.1', stderr: 'warn', end: { t: 'pb.end' as const, runId: 'r1', exit: 0, durationMs: 1500, truncated: false, ranAs: 'user' as const, ts: 1 }, opError: null }];
    render(<PlaybookPanel playbooks={pbs} runs={runs} elevated={false} canRun supported onRun={onRun} onCancel={vi.fn()} />);
    expect(screen.getByText('Request elevation first')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Run...' })[1]).toHaveProperty('disabled', true);
    expect(screen.getByText('Reply from 1.1.1.1')).toBeTruthy();
    expect(screen.getByText(/ran as user/)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Run...' })[0]!);
    await userEvent.type(screen.getByLabelText('Host (required)'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Run Ping host' }));
    expect(onRun).toHaveBeenCalledWith(pbs[0], { host: 'example.com' });
    expect(await screen.findByText(PLAYBOOK_CHANGED_TEXT)).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'stderr' }));
    expect(screen.getByText('warn')).toBeTruthy();
  });
});

describe('AgentStats', () => {
  it('shows encoder, capture path, recorder leg, the floor badge and glass-to-glass against the target', () => {
    render(
      <AgentStats
        glassMs={180}
        stats={{ t: 'agent.stats', encoder: 'h264', hwEncoder: true, capturePath: 'dda', rung: 'floor', floorMode: true, targetKbps: 250, sentKbps: 490, recorderKbps: 240, captureFps: 5, sentFps: 5, encodeMs: 3.2, monitors: [{ id: 1, width: 1024, height: 576, fps: 5 }], cpuPercent: 12, ts: 1 }}
      />,
    );
    expect(screen.getByText('Low bandwidth mode')).toBeTruthy();
    expect(screen.getByText('H264 (hardware)')).toBeTruthy();
    expect(screen.getByText('Desktop Duplication')).toBeTruthy();
    expect(screen.getByText('240 kbps')).toBeTruthy();
    expect(screen.getByText('180 ms (target < 150 ms)')).toBeTruthy();
    expect(screen.getByText(/above the 150 ms target/)).toBeTruthy();
  });
});
