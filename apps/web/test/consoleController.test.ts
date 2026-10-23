/** Assist console controller: resume, consent gate, perfect negotiation answer, stats, chat relay, teardown. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistConsoleController } from '../src/assist/console/controller';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, LATER } from './fakes';

const org = { displayName: 'Acme IT', accentColor: null, logoData: null };
const created = (state: 'consent_pending' | 'active') => ({
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier: 'p1_browser',
  state,
  consentState: state === 'active' ? 'granted' : 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'Rahul' },
  org,
  polite: true,
  iceServers: [{ urls: ['stun:turn.example.com:3478'] }],
  iceTtl: 3600,
  iceExpiresAt: LATER,
});

let ws: FakeWebSocket;
let signal: SignalClient;
let ctrl: AssistConsoleController;

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  ws = FakeWebSocket.instances[0]!;
  ws.open();
  ctrl = new AssistConsoleController({ signal, sessionId: IDS.session, RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection });
});

afterEach(() => {
  ctrl.dispose();
  signal.close();
  vi.useRealTimers();
});

describe('AssistConsoleController', () => {
  it('resumes after reload, waits for consent, then answers the Desk offer', async () => {
    ctrl.start(undefined, true);
    expect(ws.ofType('assist.resume')).toEqual([expect.objectContaining({ sessionId: IDS.session })]);
    ws.receive(created('consent_pending'));
    expect(ctrl.snapshot.phase).toBe('waiting_consent');
    expect(FakePeerConnection.instances).toHaveLength(0);

    ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'monitor' });
    expect(ctrl.snapshot.phase).toBe('connecting');
    expect(FakePeerConnection.instances).toHaveLength(1);
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.config).toMatchObject({ bundlePolicy: 'max-bundle', iceCandidatePoolSize: 2, iceTransportPolicy: 'all' });
    expect(pc.config.iceServers).toEqual([{ urls: ['stun:turn.example.com:3478'] }]);

    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 desk' });
    await vi.waitFor(() => expect(ws.ofType('webrtc.answer')).toHaveLength(1));
    expect(ws.ofType('webrtc.answer')[0]).toMatchObject({ sessionId: IDS.session, sdp: 'v=0 fake' });
  });

  it('a second assist.hello.ok (signaling reconnect) re-sends assist.resume', () => {
    ctrl.start(created('consent_pending') as never, true);
    expect(ws.ofType('assist.resume')).toHaveLength(0);
    ws.receive({ t: 'assist.hello.ok', connectionId: 'c2', user: { id: IDS.user, name: 'Anil K', role: 'technician' }, region: 'in-mum' });
    expect(ws.ofType('assist.resume')).toHaveLength(1);
  });

  it('ignores messages for other sessions', () => {
    ctrl.start(created('consent_pending') as never, true);
    ws.receive({ t: 'consent.changed', sessionId: IDS.other, state: 'granted' });
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it('falls back to the WS chat relay while ia.chat is not open', () => {
    ctrl.start(created('active') as never, true);
    ctrl.sendChat('  hello there ');
    const relayed = ws.ofType('chat.message');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ sessionId: IDS.session, from: 'assist', text: 'hello there' });
    ws.receive({ ...relayed[0], from: 'desk', text: 'hi', msgId: '66666666-6666-4666-8666-666666666666' });
    ws.receive({ ...relayed[0], from: 'desk', text: 'hi', msgId: '66666666-6666-4666-8666-666666666666' });
    expect(ctrl.snapshot.chat.map((c) => c.text)).toEqual(['hello there', 'hi']);
  });

  it('sends session.stats every 5 s while connected (prd-F9)', async () => {
    vi.useFakeTimers();
    ctrl.start(created('active') as never, true);
    await vi.advanceTimersByTimeAsync(5000);
    const stats = ws.ofType('session.stats');
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ sessionId: IDS.session, path: 'unknown', rttMs: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.ofType('session.stats')).toHaveLength(2);
  });

  it('a session ended before the first report still sends its last stats before session.end (prd-F9)', async () => {
    vi.useFakeTimers();
    ctrl.start(created('active') as never, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ws.ofType('session.stats')).toHaveLength(0);
    await ctrl.endSession();
    const types = ws.messages().map((m) => m.t);
    expect(types.indexOf('session.stats')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('session.stats')).toBeLessThan(types.indexOf('session.end'));
  });

  it('measures time to first frame from consent granted, once per grant (prd-F8)', () => {
    vi.useFakeTimers();
    ctrl.start(created('consent_pending') as never, true);
    ctrl.firstFrame();
    expect(ctrl.snapshot.ttffMs).toBeNull();
    ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'monitor' });
    vi.advanceTimersByTime(1200);
    ctrl.firstFrame();
    expect(ctrl.snapshot.ttffMs).toBe(1200);
    vi.advanceTimersByTime(5000);
    ctrl.firstFrame();
    expect(ctrl.snapshot.ttffMs).toBe(1200);
  });

  it('restarts the media path on failure with a visible reconnecting phase, bounded (correctness-F6)', () => {
    vi.useFakeTimers();
    ctrl.start(created('active') as never, true);
    const pc = FakePeerConnection.instances[0]!;
    pc.setConnectionState('connected');
    expect(ctrl.snapshot.phase).toBe('live');
    pc.setConnectionState('failed');
    expect(ctrl.snapshot.phase).toBe('reconnecting');
    expect(ctrl.snapshot.notice).toMatch(/Reconnecting/);
    // Attempt 1 is the Desk's (impolite) restart; attempt 2 forces relay, which restarts ICE here.
    expect(pc.restarts).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(ctrl.snapshot.relayOnly).toBe(true);
    expect(pc.restarts).toBe(1);
    vi.advanceTimersByTime(10000);
    expect(pc.restarts).toBe(2);
    vi.advanceTimersByTime(10000);
    expect(ctrl.snapshot.notice).toMatch(/could not be restored/);
    vi.advanceTimersByTime(60000);
    expect(pc.restarts).toBe(2);
    pc.setConnectionState('connected');
    expect(ctrl.snapshot.phase).toBe('live');
    expect(ctrl.snapshot.notice).toBeNull();
  });

  it('desk.reconnected to consent_pending tears the connection down (hard rule 2)', () => {
    ctrl.start(created('active') as never, true);
    const pc = FakePeerConnection.instances[0]!;
    ws.receive({ t: 'desk.reconnected', sessionId: IDS.session, state: 'consent_pending', consentState: 'pending' });
    expect(pc.closed).toBe(true);
    expect(ctrl.snapshot.phase).toBe('waiting_consent');
  });

  it('session.ended tears everything down before showing the ended state', () => {
    ctrl.start(created('active') as never, true);
    const pc = FakePeerConnection.instances[0]!;
    ws.receive({
      t: 'session.ended',
      sessionId: IDS.session,
      endReason: 'desk_stopped',
      endedAt: LATER,
      startedAt: LATER,
      durationMs: 0,
      hashChainTail: null,
      assist: { id: IDS.user, name: 'Anil K' },
      surface: 'monitor',
      recordingStarted: false,
      reachedActive: true,
    });
    expect(pc.closed).toBe(true);
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.remoteVideo).toBeNull();
  });

  it('End session tears down locally first, then sends session.end', async () => {
    ctrl.start(created('active') as never, true);
    const pc = FakePeerConnection.instances[0]!;
    await ctrl.endSession();
    expect(pc.closed).toBe(true);
    expect(ws.ofType('session.end')).toEqual([expect.objectContaining({ sessionId: IDS.session })]);
    expect(ctrl.snapshot.phase).toBe('ending');
  });
});
