/**
 * A native console that attaches or re-attaches to a live session learns the consent level from the server's replay
 * (`consent.changed` right after `session.created`, apps/api/src/signal/assist.ts `replayAgentConsent`): the
 * resumed `session.created { active }` keeps whatever level the console already had, the replay then sets the
 * server's level, and a later live change still wins because it arrives after the replay on the same socket.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentConsoleController } from '../src/assist/console/agent/agentConsoleController';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, LATER } from './fakes';

const FD = 'd'.repeat(64);
const FA = 'a'.repeat(64);

const created = (state: string) => ({
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: null,
  tier: 'p4_installed',
  state,
  consentState: state === 'active' ? 'granted' : 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'lab-ubuntu-01' },
  org: { displayName: 'Acme IT', accentColor: null, logoData: null },
  polite: true,
  agent: { playbooks: [] },
  iceServers: [],
  iceTtl: 3600,
  iceExpiresAt: LATER,
});

const consent = (level: string) => ({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'monitor', level, monitors: 1, clipboard: false });

let ws: FakeWebSocket;
let signal: SignalClient;
let ctrl: AgentConsoleController;

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  ws = FakeWebSocket.instances[0]!;
  ws.open();
  ctrl = new AgentConsoleController({
    signal,
    sessionId: IDS.session,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    fingerprints: () => ({ own: FA, remote: FD }),
    report: async () => {},
    loadPolicy: async () => ({ requireSasConfirm: true }),
  });
});

afterEach(() => {
  ctrl.dispose();
  signal.close();
});

describe('the replayed consent of a resumed native session', () => {
  it('a console that attaches after the Desk consented gets the server level, not "View only"', () => {
    // First attach of a REST-opened device session: the console asks for the session itself.
    ctrl.start(undefined, true);
    expect(ws.ofType('assist.resume')).toHaveLength(1);
    ws.receive(created('active'));
    expect(ctrl.snapshot.consent.level).toBe('view');
    ws.receive(consent('control'));
    expect(ctrl.snapshot.consent.level).toBe('control');
  });

  it('a reconnect keeps the level through session.created, the replay confirms it, and a later change wins', () => {
    ctrl.start(created('consent_pending') as never, true);
    ws.receive(consent('control'));
    expect(ctrl.snapshot.consent.level).toBe('control');
    // The resumed session.created never downgrades what the console knows...
    ws.receive(created('active'));
    expect(ctrl.snapshot.consent.level).toBe('control');
    // ...the replay repeats the server's record...
    ws.receive(consent('control'));
    expect(ctrl.snapshot.consent.level).toBe('control');
    // ...and a live change sent after it applies.
    ws.receive(consent('view'));
    expect(ctrl.snapshot.consent.level).toBe('view');
  });
});
