/**
 * Assist-side recording (contracts section 9): the console renders the remote frame through a canvas
 * carrying the technician watermark, and records `canvas.captureStream()` mixed (AudioContext) with the
 * remote audio and the local microphone using MediaRecorder, timeslice 1000 ms, parts kept in memory.
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

type CaptureCanvas = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };

export class SessionRecorder {
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private startedAt = 0;
  private mime = 'video/webm';
  private stopPromise: Promise<RecordingResult> | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audioStreams: () => MediaStream[],
  ) {}

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  /** Throws when the browser cannot record (no captureStream or MediaRecorder). */
  start(): void {
    const c = this.canvas as CaptureCanvas;
    if (typeof c.captureStream !== 'function' || typeof MediaRecorder === 'undefined')
      throw new Error('This browser cannot record the session.');
    const video = c.captureStream(15);
    const tracks: MediaStreamTrack[] = [...video.getVideoTracks()];
    const audio = this.audioStreams().filter((s) => s.getAudioTracks().length > 0);
    if (audio.length > 0 && typeof AudioContext !== 'undefined') {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const s of audio) ctx.createMediaStreamSource(s).connect(dest);
      this.audioCtx = ctx;
      tracks.push(...dest.stream.getAudioTracks());
    }
    this.mime = pickRecorderMime();
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: this.mime });
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.parts.push(ev.data);
    };
    this.recorder = rec;
    this.startedAt = Date.now();
    rec.start(1000);
  }

  /** Stops (idempotent) and resolves with every recorded part joined. */
  stop(): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    const rec = this.recorder;
    const finish = (): RecordingResult => {
      void this.audioCtx?.close().catch(() => undefined);
      this.audioCtx = null;
      const mime = this.mime.split(';')[0] ?? 'video/webm';
      return { blob: new Blob(this.parts, { type: mime }), mime, durationMs: Date.now() - this.startedAt };
    };
    this.stopPromise = new Promise<RecordingResult>((resolve) => {
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
