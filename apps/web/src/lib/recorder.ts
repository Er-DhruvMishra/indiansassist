/**
 * Assist-side recording (contracts section 9): the console renders the remote frame through a canvas
 * carrying the technician watermark, and records `canvas.captureStream()` mixed (AudioContext) with the
 * remote audio and the local microphone using MediaRecorder, timeslice 1000 ms, parts kept in memory.
 *
 * The audio graph lives for the whole recording (prd-F4 / correctness-F7): the destination's track is in
 * the recorded stream from the first frame, and `setAudioSources()` connects / disconnects sources as voice
 * is turned on, a remote track is replaced or a link is rebuilt. A MediaRecorder error or an unexpected stop
 * marks the recording failed (correctness-F10); `stop()` then resolves `ok: false` and never hands back an
 * empty or broken blob for upload.
 */

export const RECORDER_MIME_PREFERENCE = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickRecorderMime(
  isSupported: (m: string) => boolean = (m) =>
    typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? MediaRecorder.isTypeSupported(m)
      : false,
): string {
  for (const m of RECORDER_MIME_PREFERENCE) if (isSupported(m)) return m;
  return 'video/webm';
}

/** `<assist name> <userId first 8> <sessionId first 8> <HH:mm:ss UTC>` */
export function watermarkText(assistName: string, userId: string, sessionId: string, now: Date = new Date()): string {
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${assistName} ${userId.slice(0, 8)} ${sessionId.slice(0, 8)} ${hh}:${mm}:${ss} UTC`;
}

/** Repeating diagonal semi-transparent (18 % alpha) watermark text over the whole frame. */
export function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  const size = Math.max(12, Math.round(Math.min(w, h) / 28));
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  const stepX = Math.max(ctx.measureText(text).width + size * 3, 200);
  const stepY = size * 5;
  const reach = Math.hypot(w, h);
  for (let y = -reach; y < reach; y += stepY) {
    const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
    for (let x = -reach; x < reach; x += stepX) {
      ctx.strokeText(text, x + offset, y);
      ctx.fillText(text, x + offset, y);
    }
  }
  ctx.restore();
}

export type RecordingResult = { blob: Blob; mime: string; durationMs: number };
export type RecordingOutcome = ({ ok: true } & RecordingResult) | { ok: false; error: string; durationMs: number };

/** Browser constructors, injectable in tests. */
export type RecorderEnv = {
  AudioContextImpl?: typeof AudioContext;
  MediaRecorderImpl?: typeof MediaRecorder;
  MediaStreamImpl?: typeof MediaStream;
  isTypeSupported?: (mime: string) => boolean;
};

export type RecorderOptions = {
  /** Fired once when the recorder fails asynchronously (error event or unexpected stop). */
  onError?: (message: string) => void;
  env?: RecorderEnv;
};

type CaptureCanvas = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };

function errorText(ev: Event): string {
  const err = (ev as Event & { error?: { message?: string; name?: string } }).error;
  return err?.message || err?.name || 'the browser stopped the recorder';
}

export class SessionRecorder {
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private sources = new Map<MediaStream, MediaStreamAudioSourceNode>();
  private keepAlive: ConstantSourceNode | null = null;
  private videoTracks: MediaStreamTrack[] = [];
  private startedAt = 0;
  private mime = 'video/webm';
  private stopping = false;
  private failure: string | null = null;
  private stopPromise: Promise<RecordingOutcome> | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: RecorderOptions = {},
  ) {}

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording' && this.failure === null;
  }

  /** The failure message once the recorder failed, else null. */
  get failed(): string | null {
    return this.failure;
  }

  /** Throws when the browser cannot record (no captureStream or MediaRecorder). */
  start(): void {
    const c = this.canvas as CaptureCanvas;
    const Rec = this.opts.env?.MediaRecorderImpl ?? (typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder);
    if (typeof c.captureStream !== 'function' || !Rec) throw new Error('This browser cannot record the session.');
    const video = c.captureStream(15);
    this.videoTracks = [...video.getVideoTracks()];
    const tracks: MediaStreamTrack[] = [...this.videoTracks];
    const Ctx = this.opts.env?.AudioContextImpl ?? (typeof AudioContext === 'undefined' ? undefined : AudioContext);
    if (Ctx) {
      // Always present, even silent: MediaRecorder never records a track added after start().
      const ctx = new Ctx();
      this.audioCtx = ctx;
      this.dest = ctx.createMediaStreamDestination();
      tracks.push(...this.dest.stream.getAudioTracks());
      // A destination with no source emits no audio frames, and Chromium's WebM muxer then writes nothing at
      // all (found by the Package 1 e2e: voice off = empty recording). A zero-offset source keeps silence flowing.
      if (typeof ctx.createConstantSource === 'function') {
        const silence = ctx.createConstantSource();
        silence.offset.value = 0;
        silence.connect(this.dest);
        silence.start();
        this.keepAlive = silence;
      }
    }
    this.mime = pickRecorderMime(this.opts.env?.isTypeSupported);
    const Stream = this.opts.env?.MediaStreamImpl ?? MediaStream;
    const rec = new Rec(new Stream(tracks), { mimeType: this.mime });
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.parts.push(ev.data);
    };
    rec.onerror = (ev) => this.fail(errorText(ev));
    rec.onstop = () => {
      if (!this.stopping) this.fail('the recorder stopped unexpectedly');
    };
    this.recorder = rec;
    this.startedAt = Date.now();
    rec.start(1000);
  }

  /** Makes the mix exactly `streams` (remote audio, microphone); safe to call any number of times. */
  setAudioSources(streams: readonly MediaStream[]): void {
    const ctx = this.audioCtx;
    const dest = this.dest;
    if (!ctx || !dest || this.stopping) return;
    const wanted = new Set(streams.filter((s) => s.getAudioTracks().length > 0));
    for (const [stream, node] of this.sources) {
      if (wanted.has(stream)) continue;
      node.disconnect();
      this.sources.delete(stream);
    }
    for (const stream of wanted) {
      if (this.sources.has(stream)) continue;
      try {
        const node = ctx.createMediaStreamSource(stream);
        node.connect(dest);
        this.sources.set(stream, node);
      } catch (e) {
        console.warn('[recorder] could not mix an audio source', e);
      }
    }
  }

  private fail(message: string): void {
    if (this.failure !== null) return;
    this.failure = message;
    this.opts.onError?.(message);
  }

  private release(): void {
    for (const node of this.sources.values()) node.disconnect();
    this.sources.clear();
    try {
      this.keepAlive?.stop();
    } catch {
      /* already stopped */
    }
    this.keepAlive?.disconnect();
    this.keepAlive = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.dest = null;
    for (const t of this.videoTracks) t.stop();
    this.videoTracks = [];
  }

  /** Stops (idempotent). `ok: false` when the recorder failed or nothing was recorded. */
  stop(): Promise<RecordingOutcome> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const rec = this.recorder;
    const finish = (): RecordingOutcome => {
      this.release();
      const durationMs = Date.now() - this.startedAt;
      if (this.failure !== null) return { ok: false, error: this.failure, durationMs };
      const bytes = this.parts.reduce((n, p) => n + p.size, 0);
      if (bytes === 0) return { ok: false, error: 'nothing was recorded', durationMs };
      const mime = this.mime.split(';')[0] ?? 'video/webm';
      return { ok: true, blob: new Blob(this.parts, { type: mime }), mime, durationMs };
    };
    this.stopPromise = new Promise<RecordingOutcome>((resolve) => {
      if (!rec || rec.state === 'inactive') return resolve(finish());
      rec.onstop = () => resolve(finish());
      try {
        rec.stop();
      } catch {
        resolve(finish());
      }
    });
    return this.stopPromise;
  }
}
