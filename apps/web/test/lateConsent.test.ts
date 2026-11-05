/**
 * A native console that mounts after the Desk consented (`src/assist/signal/lateConsent.ts`): the signal provider keeps
 * the latest `consent.changed` of an accepted session, and the controller applies it when it starts, so the console
 * does not sit at "View only" for a session the Desk granted `control`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AgentConsoleController } from '../src/assist/console/agent/agentConsoleController';
import { lateConsentFor, rememberLateConsent } from '../src/assist/signal/lateConsent';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS } from './fakes';

const created = {
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier: 'p3_portable',
  state: 'consent_pending',
  consentState: 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'Desk' },
  iceServers: [],
};

let ctrl: AgentConsoleController | null = null;
let signal: SignalClient | null = null;
afterEach(() => {
  ctrl?.dispose();
  signal?.close();
});

function controller(): AgentConsoleController {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  FakeWebSocket.instances[0]!.open();
  ctrl = new AgentConsoleController({
    signal,
    sessionId: IDS.session,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    fingerprints: () => ({ own: 'a', remote: 'b' }),
    report: async () => undefined,
    loadPolicy: async () => ({ requireSasConfirm: true }),
  });
  return ctrl;
}

describe('a consent that arrived before the console mounted', () => {
  it('is applied when the controller starts', () => {
    const cached = { ...created };
    rememberLateConsent(cached as never, { sessionId: IDS.session, state: 'granted', level: 'control', monitors: 1, clipboard: false });
    const c = controller();
    c.start(cached as never, true, null);
    expect(c.snapshot.consent.level).toBe('control');
    expect(c.snapshot.consent.monitors).toBe(1);
  });

  it('is keyed by the cached session.created and ignored for another session', () => {
    const cached = { ...created };
    expect(lateConsentFor(cached as never)).toBeUndefined();
    expect(lateConsentFor(undefined)).toBeUndefined();
    rememberLateConsent(cached as never, { sessionId: 'another', state: 'granted', level: 'control' });
    const c = controller();
    c.start(cached as never, true, null);
    expect(c.snapshot.consent.level).toBeNull();
  });
});
