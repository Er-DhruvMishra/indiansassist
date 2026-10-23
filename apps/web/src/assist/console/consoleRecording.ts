/**
 * Console recording lifecycle (contracts section 9): start, live audio mix updates, stop, upload and the
 * failure states. Owned by the console controller, which passes in how to patch its snapshot, how to tell
 * the Desk (`recording.state` on `ia.ctrl`) and which audio streams currently exist.
 */
import type { Recording } from '@indiansassist/shared';
import { errorMessage } from '../../lib/api';
import { sessionsApi } from '../../lib/endpoints';
import { SessionRecorder, type RecordingResult } from '../../lib/recorder';
import { uploadRecording } from '../../lib/upload';

export type RecordingPhase = 'idle' | 'recording' | 'uploading' | 'stored' | 'failed';
/** `recorder`: the capture itself failed and nothing can be uploaded; `upload`: a retry is possible. */
export type RecordingFailure = 'recorder' | 'upload' | null;

export type RecordingSnap = {
  recording: RecordingPhase;
  recordingUsed: boolean;
  recordingFailure: RecordingFailure;
  uploadProgress: number;
  recordingResult: Recording | null;
  error: string | null;
};

export type RecorderFactory = (canvas: HTMLCanvasElement, onError: (message: string) => void) => SessionRecorder;

export type ConsoleRecordingDeps = {
  sessionId: string;
  set: (patch: Partial<RecordingSnap>) => void;
  isUsed: () => boolean;
  /** Sends `recording.state` on `ia.ctrl` when the channel is open. */
  sendCtrl: (recording: boolean) => void;
  audioSources: () => MediaStream[];
  createRecorder?: RecorderFactory;
};

const defaultFactory: RecorderFactory = (canvas, onError) => new SessionRecorder(canvas, { onError });

export class ConsoleRecording {
  private recorder: SessionRecorder | null = null;
  private lastBlob: RecordingResult | null = null;

  constructor(private readonly deps: ConsoleRecordingDeps) {}

  get active(): boolean {
    return this.recorder !== null;
  }

  start(canvas: HTMLCanvasElement | null): void {
    if (!canvas || this.recorder || this.deps.isUsed()) return;
    const create = this.deps.createRecorder ?? defaultFactory;
    const rec = create(canvas, (message) => this.onRecorderError(rec, message));
    try {
      rec.start();
    } catch (e) {
      this.deps.set({ error: errorMessage(e) });
      return;
    }
    this.recorder = rec;
    rec.setAudioSources(this.deps.audioSources());
    this.deps.set({ recording: 'recording', recordingUsed: true, recordingFailure: null, error: null });
    this.deps.sendCtrl(true);
    sessionsApi.recordingStarted(this.deps.sessionId).catch((e: unknown) => this.deps.set({ error: `Could not report the recording: ${errorMessage(e)}` }));
  }

  /** Re-reads the audio streams into the live mix (voice toggled, remote track replaced, link rebuilt). */
  syncAudio(): void {
    this.recorder?.setAudioSources(this.deps.audioSources());
  }

  private failed(message: string): void {
    this.lastBlob = null;
    this.deps.set({ recording: 'failed', recordingFailure: 'recorder', error: `Recording failed (${message}). Nothing was uploaded.` });
  }

  /** The MediaRecorder died mid-session: stop showing "recording" and tell the Desk (correctness-F10). */
  private onRecorderError(rec: SessionRecorder, message: string): void {
    if (this.recorder !== rec) return;
    this.recorder = null;
    this.deps.sendCtrl(false);
    void rec.stop();
    this.failed(message);
  }

  /** Stops and uploads. `notifyPeer` is false during teardown (nothing more is sent on ia.ctrl). */
  async stop(notifyPeer: boolean): Promise<void> {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    if (notifyPeer) this.deps.sendCtrl(false);
    const out = await rec.stop();
    if (!out.ok) return this.failed(out.error);
    this.lastBlob = { blob: out.blob, mime: out.mime, durationMs: out.durationMs };
    await this.retryUpload();
  }

  async retryUpload(): Promise<void> {
    const b = this.lastBlob;
    if (!b || b.blob.size === 0) return;
    this.deps.set({ recording: 'uploading', uploadProgress: 0, recordingFailure: null });
    try {
      const result = await uploadRecording(this.deps.sessionId, b.blob, { mime: b.mime, durationMs: Math.round(b.durationMs) }, (sent, total) =>
        this.deps.set({ uploadProgress: total > 0 ? sent / total : 1 }),
      );
      this.deps.set({ recording: 'stored', recordingResult: result, uploadProgress: 1 });
    } catch (e) {
      this.deps.set({ recording: 'failed', recordingFailure: 'upload', error: `Recording upload failed: ${errorMessage(e)}` });
    }
  }
}
