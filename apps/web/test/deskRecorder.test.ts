/**
 * Phase A.2 section 7 N3 / N4 / S3 / S4: the Desk's second peer connection toward the server recorder. It carries
 * the same screen track (and microphone) as the Assist connection, answers with `peer: 'recorder'`, receives
 * only recorder-tagged ICE, is refused outside sharing / mode server-both / with a data channel, and closes
 * on the server-source `session.recording { recording: false }`, teardown and `assist.reconnected`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeskController } from '../src/desk/deskController';
import { recordingLabel } from '../src/desk/deskMedia';
import { FakePeerConnection, FakeWebSocket, IDS, LATER, fakeStream, fakeTrack } from './fakes';

const COMPACT = 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.c2ln';
const org = { displayName: 'Acme IT', accentColor: null, logoData: null };
const ICE = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }];
const RECORDER_SDP =
  'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n';
const helloOk = {
  t: 'desk.hello.ok',
  connectionId: 'c1',
  tokenId: IDS.token,
  tier: 'p1_browser',
  technician: { name: 'Priya S' },
  org,
  region: 'in-mum',
};
const created = (recordingMode: string) => ({
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
  recordingMode,
});
const recorderOffer = (sdp = RECORDER_SDP) => ({ t: 'webrtc.offer', sessionId: IDS.session, sdp, peer: 'recorder' });

let ctrl: DeskController;
let screenTrack: ReturnType<typeof fakeTrack>;
let micTrack: ReturnType<typeof fakeTrack>;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function toSharing(mode = 'server'): Promise<{ ws: FakeWebSocket; assistPc: FakePeerConnection }> {
  ctrl.start();
  const ws = FakeWebSocket.instances[0]!;
  ws.open();
  ws.receive(helloOk);
  ws.receive({ t: 'knock.ok', sessionId: IDS.session, resumeKey: 'rk-secret', expiresAt: LATER });
  ws.receive(created(mode));
  await ctrl.share(true);
  ws.receive({
    t: 'consent.ok',
    sessionId: IDS.session,
    state: 'active',
    consentState: 'granted',
    iceServers: ICE,
    iceTtl: 3600,
    iceExpiresAt: LATER,
  });
  expect(ctrl.snapshot.phase).toBe('sharing');
  expect(FakePeerConnection.instances).toHaveLength(1);
  return { ws, assistPc: FakePeerConnection.instances[0]! };
}

async function offerFromRecorder(ws: FakeWebSocket, sdp?: string): Promise<FakePeerConnection | undefined> {
  const before = FakePeerConnection.instances.length;
  ws.receive(recorderOffer(sdp));
  await flush();
  return FakePeerConnection.instances.length > before ? FakePeerConnection.instances.at(-1) : undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  screenTrack = fakeTrack('video', 'window');
  micTrack = fakeTrack('audio');
  ctrl = new DeskController({
    url: 'ws://x/signal',
    token: COMPACT,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    getDisplayMedia: async () => fakeStream([screenTrack]),
    getUserMedia: async () => fakeStream([micTrack]),
    pollMs: 600000,
  });
});

afterEach(() => {
  ctrl.dispose();
  vi.useRealTimers();
});

describe('Desk recorder peer connection (A.2 N3)', () => {
  it('a recorder offer creates a second connection with the same screen track and answers with peer recorder', async () => {
    const { ws, assistPc } = await toSharing('server');
    const rec = await offerFromRecorder(ws);
    expect(rec).toBeDefined();
    expect(rec).not.toBe(assistPc);
    expect(rec!.config).toMatchObject({ bundlePolicy: 'max-bundle', iceServers: ICE });
    expect(rec!.remoteDescription).toEqual({ type: 'offer', sdp: RECORDER_SDP });
    // The same capture track object on both connections; never a data channel (S4).
    expect(rec!.tracks).toEqual([screenTrack]);
    expect(assistPc.tracks).toContain(screenTrack);
    expect(rec!.channels).toHaveLength(0);
    // No microphone yet: the audio transceiver is send-only and empty, ready for replaceTrack.
    const audio = rec!.transceivers.find((t) => t.receiver.track.kind === 'audio')!;
    expect(audio.direction).toBe('sendonly');
    expect(audio.sender.track).toBeNull();
    expect(ws.ofType('webrtc.answer')).toEqual([
      expect.objectContaining({ sessionId: IDS.session, sdp: 'v=0 fake answer', peer: 'recorder' }),
    ]);
    expect(assistPc.closed).toBe(false);

    // Voice on later attaches the same microphone without renegotiation; voice off detaches it.
    await ctrl.toggleVoice();
    expect(audio.sender.replaced).toEqual([micTrack]);
    expect(assistPc.tracks).toContain(micTrack);
    await ctrl.toggleVoice();
    expect(audio.sender.replaced).toEqual([micTrack, null]);
    expect(ws.ofType('webrtc.offer')).toHaveLength(0);
  });

  it('adds the live microphone track to the recorder connection', async () => {
    const { ws, assistPc } = await toSharing('both');
    await ctrl.toggleVoice();
    const rec = await offerFromRecorder(ws);
    expect(rec!.tracks).toEqual([screenTrack, micTrack]);
    expect(assistPc.tracks).toEqual(expect.arrayContaining([screenTrack, micTrack]));
    expect(rec!.transceivers.find((t) => t.receiver.track.kind === 'audio')!.sender.track).toBe(micTrack);
  });

  it('routes recorder-tagged ICE to the recorder connection and trickles its own with peer recorder', async () => {
    const { ws, assistPc } = await toSharing('server');
    const rec = (await offerFromRecorder(ws))!;
    const cand = { candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    ws.receive({ t: 'webrtc.ice', sessionId: IDS.session, candidate: cand, peer: 'recorder' });
    await flush();
    expect(rec.candidates).toEqual([cand]);
    expect(assistPc.candidates).toEqual([]);
    // Untagged frames keep the Assist path.
    ws.receive({ t: 'webrtc.ice', sessionId: IDS.session, candidate: cand });
    await flush();
    expect(assistPc.candidates).toEqual([cand]);
    expect(rec.candidates).toHaveLength(1);

    const local = { candidate: 'candidate:2 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    (rec.onicecandidate as unknown as (e: { candidate: { toJSON: () => object } | null }) => void)({
      candidate: { toJSON: () => local },
    });
    (rec.onicecandidate as unknown as (e: { candidate: null }) => void)({ candidate: null });
    const sent = ws.ofType('webrtc.ice');
    expect(sent).toEqual([
      expect.objectContaining({ sessionId: IDS.session, candidate: local, peer: 'recorder' }),
      expect.objectContaining({ sessionId: IDS.session, candidate: null, peer: 'recorder' }),
    ]);
  });

  it('drops recorder ICE when no recorder connection exists', async () => {
    const { ws, assistPc } = await toSharing('server');
    ws.receive({
      t: 'webrtc.ice',
      sessionId: IDS.session,
      candidate: { candidate: 'x', sdpMid: '0' },
      peer: 'recorder',
    });
    await flush();
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(assistPc.candidates).toEqual([]);
  });

  it('ignores a recorder offer under mode assist_only', async () => {
    const { ws } = await toSharing('assist_only');
    expect(await offerFromRecorder(ws)).toBeUndefined();
    expect(ws.ofType('webrtc.answer')).toHaveLength(0);
  });

  it('ignores a recorder offer whose SDP has a data channel (S4)', async () => {
    const { ws } = await toSharing('server');
    expect(
      await offerFromRecorder(ws, `${RECORDER_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`),
    ).toBeUndefined();
    expect(ws.ofType('webrtc.answer')).toHaveLength(0);
  });

  it('ignores a recorder offer before sharing', async () => {
    ctrl.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    ws.receive(helloOk);
    ws.receive({ t: 'knock.ok', sessionId: IDS.session, resumeKey: 'rk', expiresAt: LATER });
    ws.receive(created('server'));
    expect(await offerFromRecorder(ws)).toBeUndefined();
  });

  it('a new recorder offer replaces the old connection', async () => {
    const { ws } = await toSharing('server');
    const first = (await offerFromRecorder(ws))!;
    const second = (await offerFromRecorder(ws))!;
    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
  });
});

describe('Desk recorder lifecycle (A.2 S1 / S3 / N4 / U2)', () => {
  it('server-source recording flags drive the banner and recording false closes only the recorder connection', async () => {
    const { ws, assistPc } = await toSharing('server');
    ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: true, source: 'server' });
    expect(ctrl.snapshot).toMatchObject({ recording: true, recordingServer: true, recordingWs: false });
    expect(recordingLabel(ctrl.snapshot)).toBe('Recording (server)');
    ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: true });
    expect(recordingLabel(ctrl.snapshot)).toBe('Recording');
    ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: false });
    expect(ctrl.snapshot.recording).toBe(true);

    const rec = (await offerFromRecorder(ws))!;
    ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: false, source: 'server' });
    expect(rec.closed).toBe(true);
    expect(assistPc.closed).toBe(false);
    expect(ctrl.snapshot).toMatchObject({
      recording: false,
      recordingServer: false,
      serverRecordingSeen: true,
      recordingSeen: true,
    });
    expect(screenTrack.stop).not.toHaveBeenCalled();
  });

  it('ice.refresh reconfigures both connections and restarts ICE only on the Assist one', async () => {
    const { ws, assistPc } = await toSharing('server');
    const rec = (await offerFromRecorder(ws))!;
    const fresh = [{ urls: 'turn:turn2.example.com:3478', username: 'u2', credential: 'p2' }];
    ws.receive({ t: 'ice.refresh', sessionId: IDS.session, iceServers: fresh, iceTtl: 3600, iceExpiresAt: LATER });
    expect(rec.lastConfig?.iceServers).toEqual(fresh);
    expect(assistPc.lastConfig?.iceServers).toEqual(fresh);
    expect(rec.restarts).toBe(0);
    expect(assistPc.restarts).toBe(1);
  });

  it('assist.reconnected closes the recorder connection with the Assist rebuild', async () => {
    const { ws, assistPc } = await toSharing('server');
    const rec = (await offerFromRecorder(ws))!;
    ws.receive({ t: 'assist.reconnected', sessionId: IDS.session, state: 'active' });
    expect(rec.closed).toBe(true);
    expect(assistPc.closed).toBe(true);
    expect(FakePeerConnection.instances.at(-1)!.tracks).toContain(screenTrack);
  });

  it('stop sharing (hard rule 2) closes the recorder connection and clears every recording flag', async () => {
    const { ws } = await toSharing('both');
    const rec = (await offerFromRecorder(ws))!;
    ws.receive({ t: 'session.recording', sessionId: IDS.session, recording: true, source: 'server' });
    ctrl.stopSharing();
    expect(rec.closed).toBe(true);
    expect(screenTrack.stop).toHaveBeenCalled();
    expect(ctrl.snapshot).toMatchObject({ recording: false, recordingServer: false });
  });

  it('a Desk resume closes the recorder connection', async () => {
    const { ws } = await toSharing('server');
    const rec = (await offerFromRecorder(ws))!;
    ws.close(1006);
    vi.advanceTimersByTime(600);
    const ws2 = FakeWebSocket.instances.at(-1)!;
    ws2.open();
    ws2.receive({ ...helloOk, resume: { sessionId: IDS.session, state: 'consent_pending', consentState: 'pending' } });
    expect(rec.closed).toBe(true);
    expect(ctrl.snapshot.phase).toBe('waiting');
  });
});
