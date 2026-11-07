/**
 * Phase F sections 6.3 and 6.5 (gate section 15.5 "web" and the `ia.cam` rows): the phone page asks before anything
 * is captured, says whether the camera is recorded, stops on Stop, on No thanks, on a refused permission and after the
 * page is hidden; `/c` asks for the code; the `ia.cam` commit-before-reveal exchange gives both sides the same code,
 * refuses a nonce before the commit and ends on a wrong reveal.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraCommit, cameraSecurityCode } from '@indiansassist/shared';
import { CameraJoinPage, setCameraPhoneDeps } from '../src/camera/CameraJoinPage';
import { CamSecAssist, CamSecPhone, formatSecurityCode, parseSecFrame, sdpFingerprint } from '../src/camera/camSec';
import { FakePeerConnection, FakeSender, FakeWebSocket, fakeStream, fakeTrack } from './fakes';

const CAMERA = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const SESSION = '44444444-4444-4444-8444-444444444444';
const CODE = 'ABCDEFGHJKMN';
const FPR_OFFER = 'sha-256 AA:BB:CC';
const FPR_ANSWER = 'sha-256 DD:EE:FF';

class PhonePc extends FakePeerConnection {
  added: { track: MediaStreamTrack; init: unknown }[] = [];
  senders: FakeSender[] = [];
  /** Runs while the offer is being made (a test ends the capture there), then lets a task pass. */
  static duringOffer: (() => void) | null = null;
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const hook = PhonePc.duringOffer;
    PhonePc.duringOffer = null;
    if (hook) {
      hook();
      await new Promise((r) => setTimeout(r, 0));
    }
    return { type: 'offer', sdp: `v=0\r\na=fingerprint:${FPR_OFFER}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` };
  }
  override async setLocalDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    await super.setLocalDescription(desc);
    if (desc?.type === 'offer') this.signalingState = 'have-local-offer';
  }
  override async setRemoteDescription(desc?: RTCSessionDescriptionInit): Promise<void> {
    await super.setRemoteDescription(desc);
    if (desc?.type === 'answer') this.signalingState = 'stable';
  }
  addTransceiver(track: MediaStreamTrack, init: unknown) {
    this.added.push({ track, init });
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return { sender };
  }
}

const hidden = { state: 'visible' as DocumentVisibilityState, listeners: [] as (() => void)[] };
const doc = {
  get visibilityState() {
    return hidden.state;
  },
  addEventListener: (_: string, fn: () => void) => hidden.listeners.push(fn),
  removeEventListener: () => undefined,
} as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

let gum: ReturnType<typeof vi.fn>;
let video: ReturnType<typeof fakeTrack>;

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  PhonePc.duringOffer = null;
  hidden.state = 'visible';
  hidden.listeners = [];
  video = fakeTrack('video');
  gum = vi.fn(async () => fakeStream([video]));
  setCameraPhoneDeps({
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    PeerConnection: PhonePc as unknown as typeof RTCPeerConnection,
    getUserMedia: gum as unknown as (c: MediaStreamConstraints) => Promise<MediaStream>,
    secureContext: () => true,
    doc,
    hiddenStopMs: 50,
    retryDelaysMs: [],
  });
});
afterEach(() => setCameraPhoneDeps(null));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/c" element={<CameraJoinPage />} />
        <Route path="/c/:code" element={<CameraJoinPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function helloOk(recording = { server: false, console: false }) {
  return {
    t: 'camera.hello.ok',
    cameraId: CAMERA,
    sessionId: SESSION,
    org: { displayName: 'Acme Support' },
    technician: { name: 'Priya S' },
    iceServers: [],
    resumeKey: 'A'.repeat(43),
    limits: { maxBitrateKbps: 1500 },
    recording,
  };
}

async function consent(recording?: { server: boolean; console: boolean }) {
  renderAt(`/c/${CODE.toLowerCase()}`);
  const ws = FakeWebSocket.instances[0]!;
  act(() => ws.open());
  expect(ws.ofType('camera.hello')[0]).toMatchObject({ code: CODE });
  act(() => ws.receive(helloOk(recording)));
  await screen.findByRole('button', { name: 'Start camera' });
  return ws;
}

describe('consent (section 6.3a)', () => {
  it('shows who asks and what is shared, and captures nothing before the tap', async () => {
    await consent();
    expect(screen.getByText(/Priya S from Acme Support asks to see what your phone's camera shows/)).toBeTruthy();
    expect(screen.getByText(/Only the camera is shared: not your screen, microphone, photos or location/)).toBeTruthy();
    expect(screen.getByText('The camera is not recorded.')).toBeTruthy();
    expect(screen.getByText(/noted in the session's audit log by a fingerprint/)).toBeTruthy();
    expect(gum).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it('says first that the camera is recorded when the session is', async () => {
    await consent({ server: true, console: false });
    expect(
      screen.getByText(
        "This support session is being recorded under Acme Support's policy, so the camera will be recorded too.",
      ),
    ).toBeTruthy();
  });

  it('No thanks sends camera.stop declined and never opens the camera', async () => {
    const ws = await consent();
    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ cameraId: CAMERA, reason: 'declined' });
    expect(gum).not.toHaveBeenCalled();
    expect(await screen.findByText(/You chose not to share your camera/)).toBeTruthy();
  });
});

describe('capture (section 6.3b, 6.3c)', () => {
  it('Start camera asks for the rear camera, offers sendonly with ia.cam, reports ready and shows the sharing bar', async () => {
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    expect(gum).toHaveBeenCalledWith({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
    });
    const pc = FakePeerConnection.instances[0] as PhonePc;
    expect(pc.added[0]!.init).toMatchObject({ direction: 'sendonly' });
    expect(pc.channels[0]!.label).toBe('ia.cam');
    expect(ws.ofType('webrtc.offer')[0]).toMatchObject({ sessionId: SESSION });
    expect(ws.ofType('webrtc.offer')[0]!.peer).toBeUndefined();
    expect(ws.ofType('camera.ready')[0]).toMatchObject({
      cameraId: CAMERA,
      width: 1280,
      height: 720,
      facing: 'environment',
    });
    expect((await screen.findAllByText('Your camera is being shared with Priya S')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('What your camera is sharing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Light' })).toBeNull(); // no torch capability

    // the recorder starts later: the phone shows "Recording" at once
    act(() =>
      ws.receive({ t: 'camera.state', cameraId: CAMERA, state: 'live', recording: { server: true, console: false } }),
    );
    expect(await screen.findByText(/Recording: this camera is being recorded/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'phone_stopped' });
    expect(video.stop).toHaveBeenCalled();
    expect(pc.closed).toBe(true);
  });

  it('answers the recorder offer with the same camera track (peer recorder)', async () => {
    const ws = await consent({ server: true, console: false });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    await act(async () =>
      ws.receive({
        t: 'webrtc.offer',
        sessionId: SESSION,
        sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
        peer: 'recorder',
      }),
    );
    const rec = FakePeerConnection.instances[1]!;
    const videoTx = rec.transceivers.find((t) => t.receiver.track.kind === 'video')!;
    expect(videoTx.direction).toBe('sendonly');
    expect(videoTx.sender.track).toBe(video);
    expect(rec.transceivers.find((t) => t.receiver.track.kind === 'audio')!.direction).toBe('inactive');
    expect(ws.ofType('webrtc.answer').find((m) => m.peer === 'recorder')).toBeTruthy();
  });

  it('explains a refused permission and tells the server', async () => {
    gum.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'permission_denied' });
    expect(await screen.findByText(/Camera access was not allowed/)).toBeTruthy();
  });

  it('stops after the page stays hidden', async () => {
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    hidden.state = 'hidden';
    act(() => hidden.listeners.forEach((l) => l()));
    await act(async () => new Promise((r) => setTimeout(r, 120)));
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'phone_stopped' });
    expect(video.stop).toHaveBeenCalled();
  });

  /** The `ended` listener the page put on a track (the fake records `addEventListener` calls). */
  function endedListener(track: MediaStreamTrack): () => void {
    const calls = (track.addEventListener as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const call = calls.find((c) => c[0] === 'ended');
    if (!call) throw new Error('no ended listener');
    return call[1] as () => void;
  }

  it('takes the camera again when the browser ends the track, without renegotiating or stopping', async () => {
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    const pc = FakePeerConnection.instances[0] as PhonePc;
    const second = fakeTrack('video');
    gum.mockResolvedValueOnce(fakeStream([second]));
    await act(async () => endedListener(video)());
    expect(gum).toHaveBeenCalledTimes(2);
    expect(pc.senders[0]!.track).toBe(second);
    expect(ws.ofType('camera.stop')).toHaveLength(0);
    expect(ws.ofType('webrtc.offer')).toHaveLength(1); // no renegotiation
    expect(video.stop).toHaveBeenCalled();
    expect(screen.getByLabelText('What your camera is sharing')).toBeTruthy();
    // a track that keeps ending: after MAX_TRACK_RECOVERIES the camera stops as unusable
    let last = second;
    for (let i = 0; i < 2; i++) {
      const next = fakeTrack('video');
      gum.mockResolvedValueOnce(fakeStream([next]));
      await act(async () => endedListener(last)());
      last = next;
    }
    expect(ws.ofType('camera.stop')).toHaveLength(0);
    await act(async () => endedListener(last)());
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'no_camera' });
  });

  it('a track the browser ends before the offer is out is taken again, and the camera is still reported ready', async () => {
    const ws = await consent();
    const second = fakeTrack('video');
    gum.mockResolvedValueOnce(fakeStream([video])).mockResolvedValueOnce(fakeStream([second]));
    PhonePc.duringOffer = () => endedListener(video)(); // the e2e failure: Chromium ended the capture here
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(ws.ofType('camera.stop')).toHaveLength(0);
    expect(ws.ofType('camera.ready')).toHaveLength(1);
    expect((FakePeerConnection.instances[0] as PhonePc).senders[0]!.track).toBe(second);
    expect((await screen.findAllByText('Your camera is being shared with Priya S')).length).toBeGreaterThan(0);
  });

  it('a camera that ends while the offer is made is never reported ready nor shown as shared', async () => {
    const ws = await consent();
    gum
      .mockResolvedValueOnce(fakeStream([video]))
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NotReadableError' }));
    PhonePc.duringOffer = () => endedListener(video)();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'no_camera' });
    expect(ws.ofType('camera.ready')).toHaveLength(0);
    expect(await screen.findByText(/No camera could be used on this device/)).toBeTruthy();
    expect(screen.queryByLabelText('What your camera is sharing')).toBeNull();
  });

  it('waits for a camera that is briefly gone (the e2e: Chromium re-listed its devices) and takes it again', async () => {
    setCameraPhoneDeps({
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      PeerConnection: PhonePc as unknown as typeof RTCPeerConnection,
      getUserMedia: gum as unknown as (c: MediaStreamConstraints) => Promise<MediaStream>,
      secureContext: () => true,
      doc,
      retryDelaysMs: [1, 1],
    });
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    const second = fakeTrack('video');
    gum
      .mockRejectedValueOnce(Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' }))
      .mockResolvedValueOnce(fakeStream([second]));
    await act(async () => endedListener(video)());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(gum).toHaveBeenCalledTimes(3);
    expect(ws.ofType('camera.stop')).toHaveLength(0);
    expect((FakePeerConnection.instances[0] as PhonePc).senders[0]!.track).toBe(second);
    // a refusal is final at once, with no retry
    const third = gum.mock.calls.length;
    gum.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await act(async () => endedListener(second)());
    expect(gum.mock.calls.length).toBe(third + 1);
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'permission_denied' });
  });

  it('a track that ends while the page is hidden stops the camera, as before', async () => {
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    hidden.state = 'hidden';
    await act(async () => endedListener(video)());
    expect(gum).toHaveBeenCalledTimes(1);
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'phone_stopped' });
  });

  it('shows the server ending the camera in words', async () => {
    const ws = await consent();
    act(() => ws.receive({ t: 'camera.closed', reason: 'assist' }));
    expect(await screen.findByText(/The technician stopped the camera/)).toBeTruthy();
  });

  it('an invalid link is explained', async () => {
    renderAt(`/c/${CODE}`);
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    act(() => ws.receive({ t: 'error', code: 'camera_link_invalid', message: 'x' }));
    expect(await screen.findByText(/This camera link is not valid any more/)).toBeTruthy();
  });
});

describe('/c code entry (W104)', () => {
  it('asks for the code and refuses a malformed one', async () => {
    renderAt('/c');
    fireEvent.change(screen.getByLabelText('Camera code'), { target: { value: 'abcd-efgh-jkmu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Type the 12 characters/)).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Camera code'), { target: { value: 'abcd-efgh-jkmn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    expect(ws.ofType('camera.hello')[0]).toMatchObject({ code: CODE });
  });
});

describe('ia.cam commit before reveal (section 6.5)', () => {
  const fp = () => ({ offer: FPR_OFFER, answer: FPR_ANSWER });
  const bytes = (seed: number) => () => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 255);

  it('gives both sides the same code (the shared vector)', () => {
    const assist = new CamSecAssist(fp, bytes(1));
    const phone = new CamSecPhone(fp, bytes(2));
    const commit = assist.commit();
    const nonce = phone.onFrame(commit);
    expect(nonce.send?.t).toBe('nonce');
    const reveal = assist.onFrame(nonce.send!);
    expect(reveal.send?.t).toBe('reveal');
    const done = phone.onFrame(reveal.send!);
    expect(done.code).toBe(reveal.code);
    expect(done.code).toBe(cameraSecurityCode(FPR_OFFER, FPR_ANSWER, bytes(1)(), bytes(2)()));
    expect(formatSecurityCode('123456')).toBe('123 456');
  });

  it('refuses a nonce sent before the commit', () => {
    const assist = new CamSecAssist(fp, bytes(1));
    expect(assist.onFrame({ t: 'nonce', n: 'A'.repeat(43) }).error).toMatch(/before the commit/);
  });

  it('a wrong reveal is an error, and so is a reveal before the commit', () => {
    const phone = new CamSecPhone(fp, bytes(2));
    expect(new CamSecPhone(fp, bytes(2)).onFrame({ t: 'reveal', n: 'A'.repeat(43) }).error).toBeTruthy();
    phone.onFrame({ t: 'commit', c: cameraCommit(bytes(1)()) });
    expect(phone.onFrame({ t: 'reveal', n: 'B'.repeat(43) }).error).toMatch(/does not match/);
  });

  it('a wrong reveal on the live page ends the camera with error', async () => {
    const ws = await consent();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start camera' })));
    const ch = (FakePeerConnection.instances[0] as PhonePc).channels[0]! as unknown as {
      onmessage: (e: { data: string }) => void;
      sent: string[];
    };
    act(() => ch.onmessage({ data: JSON.stringify({ t: 'commit', c: cameraCommit(bytes(1)()) }) }));
    expect(parseSecFrame(ch.sent[0])?.t).toBe('nonce');
    act(() => ch.onmessage({ data: JSON.stringify({ t: 'reveal', n: 'B'.repeat(43) }) }));
    expect(ws.ofType('camera.stop')[0]).toMatchObject({ reason: 'error' });
    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
  });

  it('reads the a=fingerprint value of an SDP', () => {
    expect(sdpFingerprint(`v=0\r\na=fingerprint:${FPR_OFFER}\r\n`)).toBe(FPR_OFFER);
    expect(sdpFingerprint('v=0')).toBeNull();
  });
});
