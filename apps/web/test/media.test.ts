/**
 * SessionRecorder (contracts section 9; prd-F4, correctness-F7, correctness-F10) and IceRecovery
 * (correctness-F6) with injected browser doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IceRecovery } from '../src/lib/iceRecovery';
import { SessionRecorder, type RecorderEnv } from '../src/lib/recorder';
import { fakeStream, fakeTrack } from './fakes';

class FakeNode {
  connected = false;
  constructor(readonly stream: MediaStream) {}
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

const destTrack = fakeTrack('audio');
class FakeAudioCtx {
  static last: FakeAudioCtx;
  nodes: FakeNode[] = [];
  closed = false;
  constructor() {
    FakeAudioCtx.last = this;
  }
  createMediaStreamDestination() {
    return { stream: fakeStream([destTrack]) };
  }
  silence: { offset: { value: number }; started: boolean; stopped: boolean; connected: boolean } | null = null;
  createConstantSource() {
    const n = {
      offset: { value: 1 },
      started: false,
      stopped: false,
      connected: false,
      connect: () => void (n.connected = true),
      disconnect: () => void (n.connected = false),
      start: () => void (n.started = true),
      stop: () => void (n.stopped = true),
    };
    this.silence = n;
    return n;
  }
  createMediaStreamSource(s: MediaStream) {
    const n = new FakeNode(s);
    this.nodes.push(n);
    return n;
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static last: FakeMediaRecorder;
  state: RecordingState = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: { tracks: MediaStreamTrack[] }, readonly opts: MediaRecorderOptions) {
    FakeMediaRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
}

const env: RecorderEnv = {
  AudioContextImpl: FakeAudioCtx as unknown as typeof AudioContext,
  MediaRecorderImpl: FakeMediaRecorder as unknown as typeof MediaRecorder,
  MediaStreamImpl: FakeMediaStream as unknown as typeof MediaStream,
  isTypeSupported: (m) => m === 'video/webm;codecs=vp8,opus',
};

let videoTrack: ReturnType<typeof fakeTrack>;
const canvas = () => ({ captureStream: () => fakeStream([videoTrack]) }) as unknown as HTMLCanvasElement;
const live = () => FakeAudioCtx.last.nodes.filter((n) => n.connected).map((n) => n.stream);

beforeEach(() => {
  videoTrack = fakeTrack('video');
});

describe('SessionRecorder', () => {
  it('records a silent audio track from the start, so audio added later is captured', () => {
    const rec = new SessionRecorder(canvas(), { env });
    rec.start();
    expect(FakeMediaRecorder.last.stream.tracks).toEqual([videoTrack, destTrack]);
    expect(FakeMediaRecorder.last.opts.mimeType).toBe('video/webm;codecs=vp8,opus');
    expect(live()).toEqual([]);
  });

  it('keeps silence flowing into the mix so Chromium writes data with voice off (e2e finding)', async () => {
    const rec = new SessionRecorder(canvas(), { env });
    rec.start();
    const silence = FakeAudioCtx.last.silence!;
    expect(silence).toMatchObject({ started: true, connected: true, offset: { value: 0 } });
    FakeMediaRecorder.last.ondataavailable?.({ data: new Blob(['x']) });
    await rec.stop();
    expect(silence).toMatchObject({ stopped: true, connected: false });
  });

  it('setAudioSources adds and removes sources on the live mix', () => {
    const rec = new SessionRecorder(canvas(), { env });
    rec.start();
    const remote = fakeStream([fakeTrack('audio')]);
    const mic = fakeStream([fakeTrack('audio')]);
    const silent = fakeStream([fakeTrack('video')]);
    rec.setAudioSources([remote]);
    expect(live()).toEqual([remote]);
    rec.setAudioSources([remote, mic, silent]);
    expect(live()).toEqual([remote, mic]);
    rec.setAudioSources([mic]);
    expect(live()).toEqual([mic]);
    expect(FakeAudioCtx.last.nodes).toHaveLength(2);
  });

  it('stop resolves ok with the parts and releases the graph and the canvas track', async () => {
    const rec = new SessionRecorder(canvas(), { env });
    rec.start();
    rec.setAudioSources([fakeStream([fakeTrack('audio')])]);
    FakeMediaRecorder.last.ondataavailable?.({ data: new Blob(['abc']) });
    const out = await rec.stop();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.blob.size).toBe(3);
      expect(out.mime).toBe('video/webm');
    }
    expect(FakeAudioCtx.last.closed).toBe(true);
    expect(live()).toEqual([]);
    expect(videoTrack.stop).toHaveBeenCalled();
  });

  it('never returns an empty recording', async () => {
    const rec = new SessionRecorder(canvas(), { env });
    rec.start();
    const out = await rec.stop();
    expect(out).toMatchObject({ ok: false, error: 'nothing was recorded' });
  });

  it('a MediaRecorder error is reported once and fails the recording even with parts', async () => {
    const onError = vi.fn();
    const rec = new SessionRecorder(canvas(), { env, onError });
    rec.start();
    FakeMediaRecorder.last.ondataavailable?.({ data: new Blob(['abc']) });
    FakeMediaRecorder.last.onerror?.(Object.assign(new Event('error'), { error: { name: 'UnknownError', message: 'encoder died' } }));
    FakeMediaRecorder.last.onerror?.(new Event('error'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('encoder died');
    expect(rec.failed).toBe('encoder died');
    expect(await rec.stop()).toMatchObject({ ok: false, error: 'encoder died' });
  });

  it('an unexpected stop is a failure; a requested stop is not', async () => {
    const onError = vi.fn();
    const rec = new SessionRecorder(canvas(), { env, onError });
    rec.start();
    FakeMediaRecorder.last.stop();
    expect(onError).toHaveBeenCalledWith('the recorder stopped unexpectedly');
    const ok = new SessionRecorder(canvas(), { env, onError: vi.fn() });
    ok.start();
    FakeMediaRecorder.last.ondataavailable?.({ data: new Blob(['x']) });
    expect((await ok.stop()).ok).toBe(true);
  });
});

describe('IceRecovery', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds restarts and resets after connected', () => {
    vi.useFakeTimers();
    const onRestart = vi.fn();
    const onGiveUp = vi.fn();
    const states: boolean[] = [];
    const r = new IceRecovery({ onRestart, onGiveUp, onReconnecting: (on) => states.push(on), maxRestarts: 2, attemptTimeoutMs: 1000 });
    r.update('failed');
    expect(onRestart).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(1000);
    expect(onRestart).toHaveBeenLastCalledWith(2);
    vi.advanceTimersByTime(1000);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(onRestart).toHaveBeenCalledTimes(2);
    r.update('connected');
    expect(states).toEqual([true, false]);
    r.update('failed');
    expect(onRestart).toHaveBeenLastCalledWith(1);
    r.dispose();
    vi.advanceTimersByTime(10000);
    expect(onRestart).toHaveBeenCalledTimes(3);
  });

  it('a disconnect that recovers within the grace restarts nothing', () => {
    vi.useFakeTimers();
    const onRestart = vi.fn();
    const r = new IceRecovery({ onRestart, onReconnecting: () => {}, disconnectGraceMs: 5000 });
    r.update('disconnected');
    vi.advanceTimersByTime(3000);
    r.update('connected');
    vi.advanceTimersByTime(10000);
    expect(onRestart).not.toHaveBeenCalled();
  });
});
