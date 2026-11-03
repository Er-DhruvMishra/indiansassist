/**
 * Phase F sections 6.1, 6.5a and 6.6 (gate section 15.5 "web"): the console's camera panel states in words, the link
 * step (QR, code, chat text), the camera's own peer connection answered `recvonly` with `peer: 'camera'`, freeze and
 * resume, the snapshot's hash and file name, Stop, the console recording of the camera track while the session
 * recording runs, and the P1 chat QR accessory only for an exact camera link.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraSlot } from '../src/assist/console/PhaseFSlots';
import { AssistSignalProvider } from '../src/assist/signal/AssistSignalProvider';
import { cameraLinkIn, CameraLinkAccessory } from '../src/camera/CameraLinkAccessory';
import { setCameraConsoleDeps } from '../src/camera/CameraPanel';
import { cameraChatText, ConsoleCameraController, snapshotFileName, type CameraApi } from '../src/camera/cameraConsole';
import { FakePeerConnection, FakeWebSocket, fakeStream, fakeTrack } from './fakes';

const SESSION = '44444444-4444-4444-8444-444444444444';
const CAMERA = '6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const LINK = {
  cameraId: CAMERA,
  url: `${window.location.origin}/c/ABCDEFGHJKMN`,
  code: 'ABCDEFGHJKMN',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (m: string) => m.startsWith('video/webm');
  state: RecordingState = 'inactive';
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType: string;
  constructor(
    readonly stream: MediaStream,
    opts: { mimeType: string },
  ) {
    this.mimeType = opts.mimeType;
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['webm-bytes'], { type: 'video/webm' }) } as BlobEvent);
    this.onstop?.();
  }
}

let fake: { [K in keyof CameraApi]: ReturnType<typeof vi.fn> };
const sendChat = vi.fn();

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  FakeRecorder.instances = [];
  sendChat.mockReset();
  fake = {
    createLink: vi.fn(async () => LINK),
    revoke: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => undefined),
    upload: vi.fn(async () => undefined),
    iceServers: vi.fn(async () => []),
  };
  setCameraConsoleDeps({
    cameraApi: fake as unknown as CameraApi,
    PeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
    MediaRecorderImpl: FakeRecorder as unknown as typeof MediaRecorder,
  });
});
afterEach(() => setCameraConsoleDeps(null));

function renderPanel(consoleRecording = false) {
  const ui = (rec: boolean) => (
    <MemoryRouter>
      <AssistSignalProvider enabled url="ws://test/signal" WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
        <CameraSlot
          session={{ id: SESSION, live: true, consoleRecording: rec }}
          sendChat={sendChat}
          tier="p1_browser"
        />
      </AssistSignalProvider>
    </MemoryRouter>
  );
  const r = render(ui(consoleRecording));
  const ws = FakeWebSocket.instances[0]!;
  act(() => ws.open());
  return { ws, rerender: (rec: boolean) => r.rerender(ui(rec)) };
}

async function toLive(ws: FakeWebSocket) {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Phone camera' })));
  act(() => ws.receive({ t: 'camera.state', cameraId: CAMERA, state: 'joined' }));
  await act(async () =>
    ws.receive({
      t: 'webrtc.offer',
      sessionId: CAMERA,
      sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n',
      peer: 'camera',
    }),
  );
  const pc = FakePeerConnection.instances[0]!;
  act(() => {
    (pc as unknown as { ontrack: (e: unknown) => void }).ontrack({
      track: { kind: 'video' },
      streams: [fakeStream([fakeTrack('video')])],
    });
    ws.receive({ t: 'camera.state', cameraId: CAMERA, state: 'live' });
  });
  return pc;
}

describe('link step (sections 6.1, 6.6)', () => {
  it('creates the link, shows QR, link, code and countdown, and sends the chat text', async () => {
    renderPanel();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Phone camera' })));
    expect(fake.createLink).toHaveBeenCalledWith(SESSION);
    expect(screen.getByRole('img', { name: 'QR code of the phone camera link' })).toBeTruthy();
    expect(screen.getByText('ABCD-EFGH-JKMN')).toBeTruthy();
    expect(screen.getByText(/The link expires in (9|10):\d\d\./)).toBeTruthy();
    expect(screen.getAllByText('Waiting for the phone').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: "Send to the Desk's chat" }));
    expect(sendChat).toHaveBeenCalledWith(
      `To show me something with your phone's camera, open this on your phone: ${LINK.url} (code ABCD-EFGH-JKMN)`,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel link' })));
    expect(fake.revoke).toHaveBeenCalledWith(SESSION, CAMERA);
    expect(screen.getAllByText('Ended: you stopped the camera').length).toBeGreaterThan(0);
  });

  it('explains a refused link in words', async () => {
    fake.createLink.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'ApiRequestError', status: 409, code: 'camera_unrecordable' }),
    );
    renderPanel();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Phone camera' })));
    expect(screen.getByRole('button', { name: 'Phone camera' })).toBeTruthy();
  });

  it('renders nothing for a P2 session', () => {
    const { container } = render(
      <MemoryRouter>
        <CameraSlot
          session={{ id: SESSION, live: true, consoleRecording: false }}
          sendChat={sendChat}
          tier="p2_extension"
        />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('live camera (sections 6.5, 6.6)', () => {
  it('answers the camera offer recvonly with peer camera on the real session id, then freezes and resumes', async () => {
    const { ws } = renderPanel();
    const pc = await toLive(ws);
    const answer = ws.ofType('webrtc.answer')[0]!;
    expect(answer).toMatchObject({ sessionId: SESSION, peer: 'camera' });
    expect(pc.channels[0]!.label).toBe('ia.cam');
    expect(pc.transceivers.every((t) => t.direction === 'recvonly')).toBe(true);
    expect(screen.getByLabelText("Phone camera, live video from the person's phone")).toBeTruthy();
    expect(screen.getByText('Camera code not confirmed. If the codes differ, stop the camera.')).toBeTruthy();
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
    expect(screen.getAllByText('Frozen').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
    // a frame of the Desk's own session (no peer) is not taken by the camera
    await act(async () => ws.receive({ t: 'webrtc.offer', sessionId: SESSION, sdp: 'v=0 desk' }));
    expect(FakePeerConnection.instances).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop camera' })));
    expect(fake.revoke).toHaveBeenCalledWith(SESSION, CAMERA);
    expect(pc.closed).toBe(true);
  });

  it('shows the end the server reports', async () => {
    const { ws } = renderPanel();
    await toLive(ws);
    act(() => ws.receive({ t: 'camera.state', cameraId: CAMERA, state: 'ended', reason: 'phone_stopped' }));
    expect(screen.getAllByText('Ended: the phone stopped').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'New phone camera link' })).toBeTruthy();
  });

  it('records the camera while the console records the session, and uploads it separately', async () => {
    const { ws, rerender } = renderPanel(false);
    await toLive(ws);
    expect(FakeRecorder.instances).toHaveLength(0);
    rerender(true);
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.instances[0]!.mimeType).not.toContain('opus');
    expect(screen.getByText('Recording')).toBeTruthy();
    await act(async () => {
      rerender(false);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(fake.upload).toHaveBeenCalledTimes(1);
    const [sid, cid, blob, meta] = fake.upload.mock.calls[0]!;
    expect([sid, cid]).toEqual([SESSION, CAMERA]);
    expect((blob as Blob).size).toBeGreaterThan(0);
    expect((meta as { mime: string }).mime).toMatch(/^video\/webm/);
  });
});

describe('snapshot (section 6.6)', () => {
  it('records the sha256 of the PNG and names the file camera-<session 8>-<YYYYMMDD-HHMMSS>.png', async () => {
    const ctrl = new ConsoleCameraController({
      sessionId: SESSION,
      signal: null,
      cameraApi: fake as unknown as CameraApi,
    });
    await ctrl.createLink();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const sha = await ctrl.recordSnapshot(new Blob([bytes], { type: 'image/png' }), 1280, 720);
    expect(sha).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(fake.snapshot).toHaveBeenCalledWith(SESSION, CAMERA, { sha256: sha, width: 1280, height: 720 });
    expect(ctrl.snapshot.snapshots).toBe(1);
    expect(snapshotFileName(SESSION, new Date(2026, 10, 2, 9, 5, 7))).toBe('camera-44444444-20261102-090507.png');
    expect(cameraChatText(LINK)).toContain('(code ABCD-EFGH-JKMN)');
  });
});

describe('P1 chat QR accessory (section 6.1 step 2)', () => {
  const origin = window.location.origin;
  it('draws the QR only for exactly one camera link on this origin', () => {
    expect(cameraLinkIn(`open ${origin}/c/ABCDEFGHJKMN (code ABCD-EFGH-JKMN)`, origin)).toBe(
      `${origin}/c/ABCDEFGHJKMN`,
    );
    expect(cameraLinkIn(`${origin}/c/ABCDEFGHJKMN and ${origin}/c/ABCDEFGHJKMP`, origin)).toBeNull();
    expect(cameraLinkIn('https://evil.example.com/c/ABCDEFGHJKMN', origin)).toBeNull();
    expect(cameraLinkIn(`${origin}/c/ABCDEFGHJKM`, origin)).toBeNull();
    expect(cameraLinkIn(`${origin}/c/ABCDEFGHJKMNX`, origin)).toBeNull();
    expect(cameraLinkIn('no link here', origin)).toBeNull();
    render(
      <CameraLinkAccessory message={{ msgId: 'm', from: 'assist', text: cameraChatText(LINK), ts: 1, mine: false }} />,
    );
    expect(screen.getByRole('img', { name: /scan it with your phone/ })).toBeTruthy();
  });

  it('draws nothing for an ordinary message', () => {
    const { container } = render(
      <CameraLinkAccessory message={{ msgId: 'm', from: 'assist', text: 'hello', ts: 1, mine: false }} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
