/**
 * Console recording (contracts section 9): the audio mix follows voice / remote tracks after Record
 * (prd-F4, correctness-F7), a failed recorder never uploads (correctness-F10), and every new ia.ctrl
 * learns the recorder state (correctness-F11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistConsoleController } from '../src/assist/console/controller';
import type { RecordingOutcome, SessionRecorder } from '../src/lib/recorder';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, LATER, fakeStream, fakeTrack, jsonResponse } from './fakes';

const created = {
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier: 'p1_browser',
  state: 'active',
  consentState: 'granted',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'Rahul' },
  org: { displayName: 'Acme IT', accentColor: null, logoData: null },
  polite: true,
  iceServers: [],
  iceTtl: 3600,
  iceExpiresAt: LATER,
};

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

type FakeRec = {
  start: ReturnType<typeof vi.fn>;
  setAudioSources: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onError: (m: string) => void;
};

let ws: FakeWebSocket;
let signal: SignalClient;
let ctrl: AssistConsoleController;
let rec: FakeRec;
let outcome: RecordingOutcome;
let uploads: string[];

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  uploads = [];
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: { code: 'internal', message: 'test' } })));
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      upload = { onprogress: null };
      withCredentials = false;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      open(_m: string, url: string) {
        uploads.push(url);
      }
      setRequestHeader() {}
      send() {
        queueMicrotask(() => this.onerror?.());
      }
    },
  );
  outcome = { ok: true, blob: new Blob(['webm-bytes']), mime: 'video/webm', durationMs: 1000 };
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  ws = FakeWebSocket.instances[0]!;
  ws.open();
  const mic = fakeStream([fakeTrack('audio')]);
  ctrl = new AssistConsoleController({
    signal,
    sessionId: IDS.session,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    getUserMedia: async () => mic,
    createRecorder: (_canvas, onError) => {
      rec = { start: vi.fn(), setAudioSources: vi.fn(), stop: vi.fn(async () => outcome), onError };
      return rec as unknown as SessionRecorder;
    },
  });
  ctrl.start(created as never, true);
});

afterEach(async () => {
  ctrl.dispose();
  signal.close();
  // A recording still running at dispose is stopped and uploaded; let that finish against the stubs.
  await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
});

function pc(): FakePeerConnection {
  return FakePeerConnection.instances[0]!;
}

function remoteAudio(): void {
  (pc().ontrack as unknown as (e: object) => void)({ track: fakeTrack('audio'), streams: [] });
}

function openCtrl(): { sent: unknown[] } {
  const ch = pc().createDataChannel('ia.ctrl') as unknown as { readyState: string; sent: unknown[] };
  ch.readyState = 'open';
  (pc().ondatachannel as unknown as (e: object) => void)({ channel: ch });
  return ch;
}

const ctrlStates = (ch: { sent: unknown[] }) =>
  ch.sent.map((s) => JSON.parse(String(s)) as { t: string; recording?: boolean }).filter((m) => m.t === 'recording.state').map((m) => m.recording);

describe('console recording', () => {
  it('rebuilds the audio mix when remote audio arrives and voice is turned on after Record', async () => {
    ctrl.startRecording(document.createElement('canvas'));
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(rec.setAudioSources).toHaveBeenLastCalledWith([]);
    remoteAudio();
    const remote = ctrl.snapshot.remoteAudio;
    expect(rec.setAudioSources).toHaveBeenLastCalledWith([remote]);
    await ctrl.toggleVoice();
    const last = rec.setAudioSources.mock.calls.at(-1)![0] as MediaStream[];
    expect(last).toHaveLength(2);
    expect(last[0]).toBe(remote);
  });

  it('a recorder error surfaces a failure, tells the Desk and never uploads', async () => {
    const ch = openCtrl();
    await Promise.resolve();
    ctrl.startRecording(document.createElement('canvas'));
    expect(ctrl.snapshot.recording).toBe('recording');
    rec.onError('NotSupportedError');
    expect(ctrl.snapshot.recording).toBe('failed');
    expect(ctrl.snapshot.recordingFailure).toBe('recorder');
    expect(ctrl.snapshot.error).toMatch(/Nothing was uploaded/);
    expect(ctrlStates(ch)).toEqual([false, true, false]);
    await ctrl.stopRecording();
    await ctrl.retryUpload();
    expect(uploads).toEqual([]);
  });

  it('an empty or failed recording is not uploaded on stop', async () => {
    outcome = { ok: false, error: 'nothing was recorded', durationMs: 10 };
    ctrl.startRecording(document.createElement('canvas'));
    await ctrl.stopRecording();
    expect(ctrl.snapshot.recording).toBe('failed');
    expect(ctrl.snapshot.recordingFailure).toBe('recorder');
    expect(uploads).toEqual([]);
  });

  it('a good recording is uploaded; an upload failure is retryable', async () => {
    ctrl.startRecording(document.createElement('canvas'));
    await ctrl.stopRecording();
    expect(uploads.length).toBeGreaterThan(0);
    expect(ctrl.snapshot.recording).toBe('failed');
    expect(ctrl.snapshot.recordingFailure).toBe('upload');
  });

  it('every new ia.ctrl learns the recorder state', async () => {
    ctrl.startRecording(document.createElement('canvas'));
    const ch = openCtrl();
    await Promise.resolve();
    expect(ctrlStates(ch)).toEqual([true]);
  });
});
