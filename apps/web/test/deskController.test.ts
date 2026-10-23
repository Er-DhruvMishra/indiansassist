/**
 * Desk controller: a local Stop / Decline survives a signaling reconnect and is recorded by the server
 * (prd-F1), the recording dot follows D3 and resets with the share (prd-F5, correctness-F11), and a failed
 * media path is restarted with a visible state (correctness-F6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '@indiansassist/shared';
import { DeskController } from '../src/desk/deskController';
import { FakePeerConnection, FakeWebSocket, IDS, LATER, fakeStream, fakeTrack } from './fakes';

const COMPACT = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const org = { displayName: 'Acme IT', accentColor: null, logoData: null };
const helloOk = (resume?: { state: string }) => ({
  t: 'desk.hello.ok',
  connectionId: 'c1',
  tokenId: IDS.token,
  tier: 'p1_browser',
  technician: { name: 'Priya S' },
  org,
  region: 'in-mum',
  ...(resume ? { resume: { sessionId: IDS.session, state: resume.state, consentState: 'pending' } } : {}),
});
const created = {
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
};
const ended = (endReason: string) => ({
  t: 'session.ended',
  sessionId: IDS.session,
  endReason,
  endedAt: LATER,
  startedAt: LATER,
  durationMs: 1000,
  hashChainTail: 'a'.repeat(64),
  assist: { id: IDS.user, name: 'Anil K' },
  surface: 'window',
  recordingStarted: false,
  reachedActive: true,
});

let ctrl: DeskController;
let screenTrack: ReturnType<typeof fakeTrack>;

function sock(i: number): FakeWebSocket {
  return FakeWebSocket.instances[i]!;
}

/** Hello, knock, session.created: the consent screen. */
function toConsent(): FakeWebSocket {
  ctrl.start();
  const ws = sock(0);
  ws.open();
  ws.receive(helloOk());
  ws.receive({ t: 'knock.ok', sessionId: IDS.session, resumeKey: 'rk-secret', expiresAt: LATER });
  ws.receive(created);
  expect(ctrl.snapshot.phase).toBe('consent');
  return ws;
}

async function toSharing(): Promise<{ ws: FakeWebSocket; pc: FakePeerConnection }> {
  const ws = toConsent();
  await ctrl.share(true);
  ws.receive({ t: 'consent.ok', sessionId: IDS.session, state: 'active', consentState: 'granted', iceServers: [] });
  expect(ctrl.snapshot.phase).toBe('sharing');
  return { ws, pc: FakePeerConnection.instances[0]! };
}

/** The socket drops (no terminal code) and the client reconnects after the backoff. */
function dropAndReconnect(ws: FakeWebSocket): FakeWebSocket {
  ws.close(1006);
  vi.advanceTimersByTime(600);
  const next = sock(FakeWebSocket.instances.length - 1);
  expect(next).not.toBe(ws);
  return next;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  screenTrack = fakeTrack('video', 'window');
  ctrl = new DeskController({
    url: 'ws://x/signal',
    token: COMPACT,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    getDisplayMedia: async () => fakeStream([screenTrack]),
    pollMs: 600000,
  });
});

afterEach(() => {
  ctrl.dispose();
  vi.useRealTimers();
});

describe('Desk local end across a signaling reconnect (prd-F1)', () => {
  it('Stop while reconnecting: teardown now, session.end after the resume, never the consent screen again', async () => {
    const { ws, pc } = await toSharing();
    ws.close(1006);
    ctrl.stopSharing();
    expect(screenTrack.stop).toHaveBeenCalled();
    expect(pc.closed).toBe(true);
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(ws.ofType('session.end')).toHaveLength(0);
    expect(sessionStorage.getItem(STORAGE_KEYS.roomResume)).toBeNull();

    vi.advanceTimersByTime(600);
    const ws2 = sock(1);
    ws2.open();
    // The kept key re-registers this socket so the server accepts the end from it.
    expect(ws2.ofType('desk.hello')[0]).toMatchObject({ resumeKey: 'rk-secret' });
    ws2.receive(helloOk({ state: 'consent_pending' }));
    expect(ws2.ofType('session.end')).toEqual([expect.objectContaining({ sessionId: IDS.session })]);
    ws2.receive({ ...created, state: 'consent_pending' });
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(ws2.ofType('desk.knock')).toHaveLength(0);

    ws2.receive(ended('desk_stopped'));
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended?.hashChainTail).toBe('a'.repeat(64));
  });

  it('after a delivered Stop, a reconnect neither resumes nor knocks and shows the local receipt', async () => {
    const { ws } = await toSharing();
    ctrl.stopSharing();
    expect(ws.ofType('session.end')).toHaveLength(1);
    const ws2 = dropAndReconnect(ws);
    ws2.open();
    expect(ws2.ofType('desk.hello')[0]!.resumeKey).toBeUndefined();
    ws2.receive(helloOk());
    expect(ws2.ofType('desk.knock')).toHaveLength(0);
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended).toMatchObject({ endReason: 'desk_stopped', hashChainTail: null, reachedActive: true });
  });

  it('Decline while reconnecting: local ended view after the fallback, revoke delivered after the resume', () => {
    const ws = toConsent();
    ws.close(1006);
    ctrl.decline();
    expect(ctrl.snapshot.phase).toBe('ending');
    vi.advanceTimersByTime(5000);
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended).toMatchObject({ endReason: 'consent_revoked', reachedActive: false });

    const ws2 = sock(FakeWebSocket.instances.length - 1);
    ws2.open();
    ws2.receive(helloOk({ state: 'consent_pending' }));
    expect(ws2.ofType('desk.consent')).toEqual([expect.objectContaining({ state: 'revoked' })]);
    ws2.receive(created);
    expect(ctrl.snapshot.phase).toBe('ended');
  });
});

describe('Desk recording indicator (prd-F5, correctness-F11)', () => {
  it('the data channel cannot clear the server-attested flag, and a resume resets both', async () => {
    const { ws, pc } = await toSharing();
    ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: true });
    expect(ctrl.snapshot.recording).toBe(true);
    const ch = pc.channels.find((c) => c.label === 'ia.ctrl')!;
    ch.onmessage?.({ data: JSON.stringify({ t: 'recording.state', recording: false, ts: Date.now() }) } as MessageEvent);
    expect(ctrl.snapshot.recordingCtrl).toBe(false);
    expect(ctrl.snapshot.recording).toBe(true);

    ws.receive(helloOk({ state: 'active' }));
    expect(ctrl.snapshot.recording).toBe(false);
    expect(ctrl.snapshot.recordingWs).toBe(false);
    expect(ctrl.snapshot.recordingSeen).toBe(true);
  });

  it('a data-channel true shows the dot; the channel closing clears it', async () => {
    const { ws, pc } = await toSharing();
    const ch = pc.channels.find((c) => c.label === 'ia.ctrl')!;
    ch.onmessage?.({ data: JSON.stringify({ t: 'recording.state', recording: true, ts: Date.now() }) } as MessageEvent);
    expect(ctrl.snapshot.recording).toBe(true);
    ws.receive({ t: 'assist.reconnected', sessionId: IDS.session, state: 'active', iceServers: [] });
    expect(ctrl.snapshot.recording).toBe(false);
  });
});

describe('Desk media recovery (correctness-F6)', () => {
  it('restarts ICE on failed, and on disconnected after the grace, with a visible state', async () => {
    const { pc } = await toSharing();
    pc.setConnectionState('connected');
    pc.setConnectionState('failed');
    expect(pc.restarts).toBe(1);
    expect(ctrl.snapshot.mediaReconnecting).toBe(true);
    pc.setConnectionState('connected');
    expect(ctrl.snapshot.mediaReconnecting).toBe(false);

    pc.setConnectionState('disconnected');
    expect(ctrl.snapshot.mediaReconnecting).toBe(true);
    vi.advanceTimersByTime(4900);
    expect(pc.restarts).toBe(1);
    vi.advanceTimersByTime(200);
    expect(pc.restarts).toBe(2);
    ctrl.stopSharing();
    expect(ctrl.snapshot.mediaReconnecting).toBe(false);
  });
});
