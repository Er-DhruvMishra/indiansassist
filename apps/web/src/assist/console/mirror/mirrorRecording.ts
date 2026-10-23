/**
 * Lifecycle of the P2 mirror recording (Phase B 4.7): start (report `recording.started`, tell the Desk on
 * `ia.ctrl`), feed events, stop, gzip, upload through the Phase A recordings endpoints, retry an upload.
 */
import type { Recording } from '@indiansassist/shared';
import { errorMessage } from '../../../lib/api';
import { sessionsApi } from '../../../lib/endpoints';
import { uploadRecording } from '../../../lib/upload';
import type { RecordingFailure, RecordingPhase } from '../consoleRecording';
import { MirrorRecorder, type RecorderHeader } from './mirrorRecorder';

/** Pinned rrweb version (record and replay must match; written into the recording header). */
export const RRWEB_VERSION = '2.1.7';

export type MirrorRecordingSnap = {
  recording: RecordingPhase;
  recordingUsed: boolean;
  recordingFailure: RecordingFailure;
  uploadProgress: number;
  recordingResult: Recording | null;
  error: string | null;
};

export type MirrorRecordingDeps = {
  sessionId: string;
  assist: () => { id: string; name: string };
  tabs: () => unknown[];
  recordRevealed: () => boolean;
  set: (patch: Partial<MirrorRecordingSnap>) => void;
  isUsed: () => boolean;
  sendCtrl: (recording: boolean) => void;
  upload?: typeof uploadRecording;
  reportStarted?: (sessionId: string) => Promise<unknown>;
};

export class MirrorRecording {
  private rec: MirrorRecorder | null = null;
  private blob: { blob: Blob; durationMs: number; mime: string } | null = null;

  constructor(private readonly deps: MirrorRecordingDeps) {}

  /** The live recorder (events are fed here), or null. */
  get recorder(): MirrorRecorder | null {
    return this.rec;
  }

  start(): void {
    if (this.rec || this.deps.isUsed()) return;
    const header: RecorderHeader = { sessionId: this.deps.sessionId, assist: this.deps.assist(), rrweb: RRWEB_VERSION, tabs: this.deps.tabs() };
    this.rec = new MirrorRecorder(header, this.deps.recordRevealed());
    this.deps.set({ recording: 'recording', recordingUsed: true, recordingFailure: null, error: null });
    this.deps.sendCtrl(true);
    (this.deps.reportStarted ?? sessionsApi.recordingStarted)(this.deps.sessionId).catch((e: unknown) =>
      this.deps.set({ error: `Could not report the recording: ${errorMessage(e)}` }),
    );
  }

  async stop(notifyPeer: boolean): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    if (notifyPeer) this.deps.sendCtrl(false);
    try {
      const blob = await rec.finish();
      this.blob = { blob, durationMs: Math.max(0, Date.now() - rec.startedAt), mime: rec.mime };
    } catch (e) {
      this.deps.set({ recording: 'failed', recordingFailure: 'recorder', error: `Recording failed (${errorMessage(e)}). Nothing was uploaded.` });
      return;
    }
    await this.retryUpload();
  }

  async retryUpload(): Promise<void> {
    const b = this.blob;
    if (!b || b.blob.size === 0) return;
    this.deps.set({ recording: 'uploading', uploadProgress: 0, recordingFailure: null });
    try {
      const upload = this.deps.upload ?? uploadRecording;
      const result = await upload(this.deps.sessionId, b.blob, { mime: b.mime, durationMs: Math.round(b.durationMs) }, (sent, total) =>
        this.deps.set({ uploadProgress: total > 0 ? sent / total : 1 }),
      );
      this.deps.set({ recording: 'stored', recordingResult: result, uploadProgress: 1 });
    } catch (e) {
      this.deps.set({ recording: 'failed', recordingFailure: 'upload', error: `Recording upload failed: ${errorMessage(e)}` });
    }
  }
}
