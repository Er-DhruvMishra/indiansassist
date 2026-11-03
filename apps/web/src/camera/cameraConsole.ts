/**
 * The console's phone-camera controller (docs/specs/phase-f-contracts.md sections 6.1, 6.5, 6.5a, 6.6). It creates and
 * cancels the link (REST), follows `camera.state`, answers the phone's `sendonly` offer `recvonly` on a separate peer
 * connection (frames tagged `peer: 'camera'`, arriving with `sessionId` = the camera id), runs the Assist side of the
 * `ia.cam` commit-before-reveal exchange, records snapshots by hash and, while the console's own session recording
 * runs, records the camera track into a separate recording (`source: 'camera'`).
 */
import type { CameraLinkReply, CameraState, CameraStopReason, IceCandidateInit } from '@indiansassist/shared';
import { cameraLinkReplySchema, formatCameraCode } from '@indiansassist/shared';
import { api, errorMessage, isApiError, request } from '../lib/api';
import { iceApi } from '../lib/endpoints';
import { pickRecorderMime } from '../lib/recorder';
import type { SignalClient } from '../lib/signal';
import { CamSecAssist, formatSecurityCode, parseSecFrame, sdpFingerprint, type RandomBytes } from './camSec';

export type ConsoleCameraPhase = 'idle' | 'creating' | 'linked' | 'joined' | 'live' | 'ended';
export type CameraRecordingPhase = 'off' | 'recording' | 'uploading' | 'stored' | 'failed';

export type ConsoleCameraSnap = {
  phase: ConsoleCameraPhase;
  link: CameraLinkReply | null;
  /** The camera's video arrived (the panel shows it). */
  hasVideo: boolean;
  securityCode: string | null;
  codesConfirmed: boolean;
  endedReason: CameraStopReason | null;
  error: string | null;
  recording: CameraRecordingPhase;
  snapshots: number;
};

export type CameraApi = {
  createLink(sessionId: string): Promise<CameraLinkReply>;
  revoke(sessionId: string, cameraId: string): Promise<void>;
  snapshot(sessionId: string, cameraId: string, body: { sha256: string; width: number; height: number }): Promise<void>;
  upload(sessionId: string, cameraId: string, blob: Blob, meta: { mime: string; durationMs: number }): Promise<void>;
  iceServers(sessionId: string): Promise<RTCIceServer[]>;
};

export const cameraApi: CameraApi = {
  createLink: (sessionId) =>
    api.post<CameraLinkReply>(`/sessions/${sessionId}/camera-links`, undefined, { schema: cameraLinkReplySchema }),
  revoke: (sessionId, cameraId) => request<void>('DELETE', `/sessions/${sessionId}/camera-links/${cameraId}`),
  snapshot: async (sessionId, cameraId, body) => {
    await api.post(`/sessions/${sessionId}/camera/${cameraId}/snapshots`, body);
  },
  upload: async (sessionId, cameraId, blob, meta) => {
    const fd = new FormData();
    fd.append('meta', JSON.stringify(meta));
    fd.append('file', blob, `camera-${cameraId}.webm`);
    await request('POST', `/sessions/${sessionId}/camera/${cameraId}/recordings`, { body: fd });
  },
  iceServers: async (sessionId) => (await iceApi.get(sessionId)).iceServers as RTCIceServer[],
};

/** Section 6.1 step 2: the chat text, whose URL the P1 room's chat draws as a QR code. */
export function cameraChatText(link: Pick<CameraLinkReply, 'url' | 'code'>): string {
  return `To show me something with your phone's camera, open this on your phone: ${link.url} (code ${formatCameraCode(link.code)})`;
}

/** Section 6.6: `camera-<session 8>-<YYYYMMDD-HHMMSS>.png` (local time of the technician's browser). */
export function snapshotFileName(sessionId: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `camera-${sessionId.slice(0, 8)}-${stamp}.png`;
}

export async function sha256HexOf(blob: Blob): Promise<string> {
  const buf =
    typeof blob.arrayBuffer === 'function'
      ? await blob.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as ArrayBuffer);
          r.onerror = () => reject(r.error);
          r.readAsArrayBuffer(blob);
        });
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Words for the states (section 6.6). */
export function endedWords(reason: CameraStopReason | null): string {
  switch (reason) {
    case 'phone_stopped':
      return 'Ended: the phone stopped';
    case 'declined':
      return 'Ended: the phone holder said no';
    case 'assist':
      return 'Ended: you stopped the camera';
    case 'session_ended':
      return 'Ended: the session ended';
    case 'link_expired':
      return 'Ended: the link expired before the phone joined';
    case 'disconnected':
      return 'Ended: the phone lost its connection';
    case 'no_camera':
      return 'Ended: the phone has no usable camera';
    case 'permission_denied':
      return 'Ended: the phone did not allow camera access';
    case 'error':
      return 'Ended: the camera connection could not be verified';
    default:
      return 'Ended';
  }
}

export type ConsoleCameraDeps = {
  sessionId: string;
  signal: SignalClient | null;
  cameraApi?: CameraApi;
  PeerConnection?: typeof RTCPeerConnection;
  MediaRecorderImpl?: typeof MediaRecorder;
  random?: RandomBytes;
};

type Listener = () => void;

export class ConsoleCameraController {
  private snap: ConsoleCameraSnap = {
    phase: 'idle',
    link: null,
    hasVideo: false,
    securityCode: null,
    codesConfirmed: false,
    endedReason: null,
    error: null,
    recording: 'off',
    snapshots: 0,
  };
  private readonly listeners = new Set<Listener>();
  private readonly offs: (() => void)[] = [];
  private readonly api: CameraApi;
  private iceServers: RTCIceServer[] = [];
  private pc: RTCPeerConnection | null = null;
  private pendingIce: (IceCandidateInit | null)[] = [];
  private sec: CamSecAssist | null = null;
  private remote: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recStartedAt = 0;
  private wantRecording = false;

  constructor(private readonly deps: ConsoleCameraDeps) {
    this.api = deps.cameraApi ?? cameraApi;
  }

  /** Subscribes to the console's signaling socket; returns the unsubscribe (React effects may run it twice). */
  attach(): () => void {
    const s = this.deps.signal;
    if (!s) return () => undefined;
    const offs = [
      s.on('camera.state', (m) => {
        if (m.cameraId === this.snap.link?.cameraId) this.onState(m.state, m.reason ?? null);
      }),
      s.on('webrtc.offer', (m) => {
        if (m.peer === 'camera' && m.sessionId === this.snap.link?.cameraId) void this.onOffer(m.sdp);
      }),
      s.on('webrtc.ice', (m) => {
        if (m.peer === 'camera' && m.sessionId === this.snap.link?.cameraId) void this.onIce(m.candidate);
      }),
    ];
    this.offs.push(...offs);
    return () => {
      for (const off of offs) off();
    };
  }

  get snapshot(): ConsoleCameraSnap {
    return this.snap;
  }

  /** The phone camera's remote stream (null before the track arrives). */
  get stream(): MediaStream | null {
    return this.remote;
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<ConsoleCameraSnap>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** **Phone camera**: `POST /sessions/:id/camera-links` (section 6.1 step 1). */
  async createLink(): Promise<void> {
    if (
      this.snap.phase === 'creating' ||
      this.snap.phase === 'linked' ||
      this.snap.phase === 'joined' ||
      this.snap.phase === 'live'
    )
      return;
    this.teardown();
    this.set({
      phase: 'creating',
      error: null,
      link: null,
      endedReason: null,
      securityCode: null,
      codesConfirmed: false,
      hasVideo: false,
      snapshots: 0,
      recording: 'off',
    });
    try {
      const [link, ice] = await Promise.all([
        this.api.createLink(this.deps.sessionId),
        this.api.iceServers(this.deps.sessionId).catch(() => [] as RTCIceServer[]),
      ]);
      this.iceServers = ice;
      // camera.state may already have moved past `linked` while the reply was in flight.
      const now = this.snap.phase as ConsoleCameraPhase;
      this.set({ phase: now === 'creating' ? 'linked' : now, link });
    } catch (e) {
      const msg = isApiError(e, 'camera_busy')
        ? 'This session already has a phone camera.'
        : isApiError(e, 'camera_unrecordable')
          ? 'This session is recorded by the server, and the recorder cannot record a phone camera, so a phone camera cannot join.'
          : isApiError(e, 'camera_unsupported')
            ? 'A phone camera cannot join this kind of session.'
            : isApiError(e, 'bad_state')
              ? 'The session is not live.'
              : errorMessage(e);
      this.set({ phase: 'idle', error: msg });
    }
  }

  /** **Cancel link** / **Stop camera**: `DELETE .../camera-links/:cameraId`. */
  async stop(): Promise<void> {
    const link = this.snap.link;
    if (!link || this.snap.phase === 'ended' || this.snap.phase === 'idle') return;
    try {
      await this.api.revoke(this.deps.sessionId, link.cameraId);
    } catch (e) {
      if (!isApiError(e, 'not_found')) return this.set({ error: errorMessage(e) });
    }
    this.end('assist');
  }

  confirmCodes(ok: boolean): void {
    this.set({ codesConfirmed: ok });
  }

  private onState(state: CameraState, reason: CameraStopReason | null): void {
    if (state === 'ended') return this.end(reason ?? 'phone_stopped');
    if (this.snap.phase === 'ended') return;
    if (state === 'joined') this.set({ phase: 'joined' });
    else if (state === 'live') {
      this.set({ phase: 'live' });
      this.syncRecording();
    }
  }

  private newPc(): RTCPeerConnection {
    const Impl = this.deps.PeerConnection ?? globalThis.RTCPeerConnection;
    const pc = new Impl({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const dc = pc.createDataChannel('ia.cam', { negotiated: true, id: 0 });
    const sec = new CamSecAssist(() => {
      const offer = sdpFingerprint(pc.remoteDescription?.sdp);
      const answer = sdpFingerprint(pc.localDescription?.sdp);
      return offer && answer ? { offer, answer } : null;
    }, this.deps.random);
    this.sec = sec;
    dc.onopen = () => dc.send(JSON.stringify(sec.commit()));
    dc.onmessage = (ev: MessageEvent) => {
      const step = sec.onFrame(parseSecFrame(ev.data));
      if (step.send) dc.send(JSON.stringify(step.send));
      if (step.code) this.set({ securityCode: formatSecurityCode(step.code) });
      if (step.error) {
        this.set({ error: 'The camera connection could not be verified, so the camera was stopped.' });
        void this.stop();
      }
    };
    pc.ontrack = (ev: RTCTrackEvent) => {
      if (ev.track.kind !== 'video') return;
      this.remote = ev.streams[0] ?? new MediaStream([ev.track]);
      this.set({ hasVideo: true });
      this.syncRecording();
    };
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc) return;
      this.deps.signal?.send({
        t: 'webrtc.ice',
        sessionId: this.deps.sessionId,
        candidate: ev.candidate ? (ev.candidate.toJSON() as IceCandidateInit) : null,
        peer: 'camera',
      });
    };
    return pc;
  }

  private async onOffer(sdp: string): Promise<void> {
    if (this.snap.phase === 'ended' || this.snap.phase === 'idle') return;
    const pc = this.pc ?? this.newPc();
    this.pc = pc;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const t of pc.getTransceivers())
        if (t.receiver.track?.kind === 'video' || t.receiver.track?.kind === 'audio') t.direction = 'recvonly';
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const local = pc.localDescription?.sdp ?? answer.sdp;
      if (local)
        this.deps.signal?.send({ t: 'webrtc.answer', sessionId: this.deps.sessionId, sdp: local, peer: 'camera' });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c ?? undefined).catch(() => undefined);
    } catch (e) {
      console.warn('[camera] answer failed', e);
    }
  }

  private async onIce(c: IceCandidateInit | null): Promise<void> {
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) {
      this.pendingIce.push(c);
      return;
    }
    await pc.addIceCandidate(c ?? undefined).catch(() => undefined);
  }

  /** Records the snapshot's fingerprint (the bytes stay in the browser, W104). */
  async recordSnapshot(blob: Blob, width: number, height: number): Promise<string> {
    const link = this.snap.link;
    if (!link) throw new Error('no camera');
    const sha256 = await sha256HexOf(blob);
    await this.api.snapshot(this.deps.sessionId, link.cameraId, { sha256, width, height });
    this.set({ snapshots: this.snap.snapshots + 1 });
    return sha256;
  }

  // ---------- console recording of the camera (section 6.5a) ----------

  /** The console's session recording runs (or stopped): the camera is recorded with it. */
  setConsoleRecording(on: boolean): void {
    this.wantRecording = on;
    this.syncRecording();
  }

  private syncRecording(): void {
    const should = this.wantRecording && this.snap.phase === 'live' && this.remote !== null;
    if (should && !this.recorder) this.startRecording();
    else if (!should && this.recorder) void this.stopRecording();
  }

  private startRecording(): void {
    const Impl = this.deps.MediaRecorderImpl ?? (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    if (!Impl || !this.remote)
      return this.set({ recording: 'failed', error: 'This browser cannot record the phone camera.' });
    const mime = pickRecorderMime((m) =>
      typeof Impl.isTypeSupported === 'function' ? Impl.isTypeSupported(m) : false,
    ).replace(',opus', '');
    try {
      const rec = new Impl(this.remote, { mimeType: mime });
      this.recChunks = [];
      rec.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) this.recChunks.push(ev.data);
      };
      rec.start(1000);
      this.recorder = rec;
      this.recStartedAt = Date.now();
      this.set({ recording: 'recording' });
    } catch {
      this.set({ recording: 'failed' });
    }
  }

  private async stopRecording(): Promise<void> {
    const rec = this.recorder;
    const link = this.snap.link;
    this.recorder = null;
    if (!rec || !link) return;
    const stopped = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      if (rec.state === 'inactive') resolve();
    });
    try {
      if (rec.state !== 'inactive') rec.stop();
    } catch {
      /* already stopped */
    }
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
    const mime =
      (rec.mimeType || 'video/webm').split(';')[0] === 'video/webm' ? rec.mimeType || 'video/webm' : 'video/webm';
    const blob = new Blob(this.recChunks, { type: mime });
    this.recChunks = [];
    if (blob.size === 0) return this.set({ recording: 'off' });
    this.set({ recording: 'uploading' });
    try {
      await this.api.upload(this.deps.sessionId, link.cameraId, blob, {
        mime,
        durationMs: Math.max(0, Date.now() - this.recStartedAt),
      });
      this.set({ recording: 'stored' });
    } catch (e) {
      this.set({ recording: 'failed', error: `The camera recording could not be uploaded: ${errorMessage(e)}` });
    }
  }

  private end(reason: CameraStopReason): void {
    if (this.snap.phase === 'ended') return;
    void this.stopRecording();
    this.teardown();
    this.set({ phase: 'ended', endedReason: reason, hasVideo: false, securityCode: null });
  }

  private teardown(): void {
    this.pc?.close();
    this.pc = null;
    this.pendingIce = [];
    this.sec = null;
    this.remote = null;
  }

  dispose(): void {
    void this.stopRecording();
    this.teardown();
    for (const off of this.offs.splice(0)) off();
  }
}
