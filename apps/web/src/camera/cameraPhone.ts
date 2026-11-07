/**
 * The phone page's controller (docs/specs/phase-f-contracts.md sections 6.3-6.5a). It joins `/signal` as a camera
 * (`camera.hello { code }`, then `{ resumeKey }` after a drop), waits for the person's tap, captures the camera with
 * the section 6.3b constraints and offers it `sendonly` to the session's Assist over its own peer connection, runs the
 * `ia.cam` exchange on the negotiated channel, answers the server recorder's offer (`peer: 'recorder'`) when the
 * session is recorded, and stops on Stop, on the technician's or the server's word, or after 60 s hidden. When the
 * browser ends the capture on its own (not the person), it takes the same camera again without renegotiating.
 *
 * Nothing is captured before `start()`; nothing is stored (no cookie, no storage): the page keeps its state in memory.
 */
import {
  LIMITS,
  type CameraFacing,
  type CameraRecording,
  type CameraStopReason,
  type IceCandidateInit,
} from '@indiansassist/shared';
import { SignalClient, type ServerOf, type SignalClientOptions } from '../lib/signal';

type CameraHelloOk = ServerOf<'camera.hello.ok'>;
import { CamSecPhone, formatSecurityCode, parseSecFrame, sdpFingerprint, type RandomBytes } from './camSec';

export type PhonePhase = 'connecting' | 'consent' | 'starting' | 'live' | 'ended' | 'invalid';

export type PhoneSnap = {
  phase: PhonePhase;
  org: string | null;
  technician: string | null;
  recording: CameraRecording;
  facing: 'environment' | 'user';
  torch: { available: boolean; on: boolean };
  /** The six-digit camera code, `123 456`, once the `ia.cam` exchange finished. */
  securityCode: string | null;
  /** Counts the captures (start, switch, a recovered track), so the page's preview follows the current one. */
  capture: number;
  endedReason: CameraStopReason | null;
  /** A sentence for the person (why it ended, what went wrong). */
  message: string | null;
};

export type PhoneDeps = {
  signalUrl: string;
  WebSocketImpl?: SignalClientOptions['WebSocketImpl'];
  PeerConnection?: typeof RTCPeerConnection;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  secureContext?: () => boolean;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  random?: RandomBytes;
  /** Hidden this long stops the camera (section 6.3b). */
  hiddenStopMs?: number;
  /**
   * The waits before asking for the camera again after a passing failure (the device was briefly gone or busy:
   * `NotFoundError`, `NotReadableError`, `AbortError`); default `CAMERA_RETRY_MS`.
   */
  retryDelaysMs?: readonly number[];
};

/** The waits between camera attempts after a passing failure: a camera that comes back within ~3 s is taken again. */
export const CAMERA_RETRY_MS: readonly number[] = [250, 1000, 2000];

/** `getUserMedia` failures that can pass: the device is briefly gone (re-listed) or busy. */
const PASSING_GUM_FAILURES = new Set(['NotFoundError', 'NotReadableError', 'AbortError']);

const ENDED_TEXT: Record<CameraStopReason, string> = {
  declined: 'You chose not to share your camera. You can close this page.',
  phone_stopped: 'You stopped sharing your camera. You can close this page.',
  assist: 'The technician stopped the camera. You can close this page.',
  session_ended: 'The support session ended, so the camera stopped. You can close this page.',
  link_expired: 'This camera link expired. Ask the technician for a new one.',
  disconnected: 'The connection was lost for too long, so the camera stopped. Ask the technician for a new link.',
  no_camera: 'No camera could be used on this device, so nothing was shared.',
  permission_denied:
    'Camera access was not allowed, so nothing was shared. You can allow it in your browser settings and open the link again.',
  error: 'The camera stopped because the connection could not be verified. Ask the technician for a new link.',
};

export function endedText(reason: CameraStopReason): string {
  return ENDED_TEXT[reason];
}

/** Section 6.3b. */
export function cameraConstraints(facing: 'environment' | 'user'): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    },
  };
}

type Listener = () => void;

export class CameraPhoneController {
  private snap: PhoneSnap = {
    phase: 'connecting',
    org: null,
    technician: null,
    recording: { server: false, console: false },
    facing: 'environment',
    torch: { available: false, on: false },
    securityCode: null,
    capture: 0,
    endedReason: null,
    message: null,
  };
  private readonly listeners = new Set<Listener>();
  /** Captures the browser ended on its own that were taken again (see `recoverTrack`). */
  private recoveries = 0;
  private recovering = false;
  private signal: SignalClient | null = null;
  private hello: CameraHelloOk | null = null;
  private resumeKey: string | null = null;
  private stream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private recPc: RTCPeerConnection | null = null;
  private recSender: RTCRtpSender | null = null;
  private pendingIce: (IceCandidateInit | null)[] = [];
  private recPendingIce: (IceCandidateInit | null)[] = [];
  private sec: CamSecPhone | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly code: string,
    private readonly deps: PhoneDeps,
  ) {}

  get snapshot(): PhoneSnap {
    return this.snap;
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<PhoneSnap>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private get ended(): boolean {
    return this.snap.phase === 'ended' || this.snap.phase === 'invalid';
  }

  connect(): void {
    const s = new SignalClient({
      url: this.deps.signalUrl,
      ...(this.deps.WebSocketImpl ? { WebSocketImpl: this.deps.WebSocketImpl } : {}),
      latencyPingMs: 0,
      onOpen: (c) => {
        if (this.ended) return;
        c.send(
          this.resumeKey ? { t: 'camera.hello', resumeKey: this.resumeKey } : { t: 'camera.hello', code: this.code },
        );
      },
      onStatus: (st, code) => {
        if (st === 'closed' && !this.ended && code !== 1000)
          this.set({
            phase: 'invalid',
            message: 'The camera could not connect to the support session. Ask the technician for a new link.',
          });
      },
    });
    this.signal = s;
    this.offs.push(
      s.on('camera.hello.ok', (m) => this.onHelloOk(m)),
      s.on('camera.state', (m) => {
        if (m.recording) this.set({ recording: m.recording });
      }),
      s.on('camera.closed', (m) => this.finish(m.reason, false)),
      s.on('error', (m) => {
        if (
          m.code === 'camera_link_invalid' ||
          m.code === 'camera_busy' ||
          m.code === 'org_erasing' ||
          m.code === 'rate_limited'
        )
          this.set({
            phase: 'invalid',
            message:
              m.code === 'camera_busy'
                ? 'Another phone is already sharing its camera in this session.'
                : m.code === 'rate_limited'
                  ? 'Too many attempts. Wait a minute and open the link again.'
                  : 'This camera link is not valid any more. Ask the technician for a new one.',
          });
      }),
      s.on('webrtc.answer', (m) => void (m.peer === 'recorder' ? undefined : this.onAnswer(m.sdp))),
      s.on(
        'webrtc.ice',
        (m) => void (m.peer === 'recorder' ? this.onRecorderIce(m.candidate) : this.onIce(m.candidate)),
      ),
      s.on('webrtc.offer', (m) => void (m.peer === 'recorder' ? this.onRecorderOffer(m.sdp) : undefined)),
    );
    const doc = this.deps.doc ?? (typeof document !== 'undefined' ? document : null);
    if (doc) {
      const onVis = () => this.onVisibility(doc.visibilityState);
      doc.addEventListener('visibilitychange', onVis);
      this.offs.push(() => doc.removeEventListener('visibilitychange', onVis));
    }
    s.connect();
  }

  private onHelloOk(m: CameraHelloOk): void {
    this.hello = m;
    this.resumeKey = m.resumeKey;
    const first = this.snap.phase === 'connecting';
    this.set({
      org: m.org.displayName,
      technician: m.technician.name,
      recording: m.recording,
      ...(first ? { phase: 'consent' as const } : {}),
    });
  }

  /** **No thanks** (section 6.3a). */
  decline(): void {
    this.stop('declined');
  }

  /** **Start camera**: the only place capture starts (section 6.3b). */
  async start(): Promise<void> {
    if (this.snap.phase !== 'consent' || !this.hello) return;
    this.set({ phase: 'starting' });
    const secure = this.deps.secureContext
      ? this.deps.secureContext()
      : typeof window !== 'undefined' && window.isSecureContext;
    const gum = this.gum();
    if (!secure || !gum) return this.stop('no_camera');
    let stream: MediaStream;
    try {
      stream = await this.acquire(gum);
    } catch (e) {
      return this.stop(gumFailure(e));
    }
    if (this.ended) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) return this.stop('no_camera');
    this.watchTrack(track);
    this.updateTorch(track);
    this.set({ capture: this.snap.capture + 1 });
    await this.offerToAssist(track, stream);
    // The camera may have ended while the offer was made (the track could not be taken again, or a server word):
    // then it is over, and must not be reported ready or shown as shared.
    if (this.ended) return;
    const current = this.stream?.getVideoTracks()[0] ?? track;
    const st = current.getSettings?.() ?? {};
    const facing: CameraFacing =
      st.facingMode === 'user' || st.facingMode === 'environment' ? st.facingMode : this.snap.facing;
    this.signal?.send({
      t: 'camera.ready',
      cameraId: this.hello.cameraId,
      width: clampDim(st.width ?? 1280),
      height: clampDim(st.height ?? 720),
      facing,
    });
    this.set({ phase: 'live' });
  }

  /**
   * `getUserMedia` for the current facing, asked again after each `retryDelaysMs` wait while the failure is a passing
   * one (the device is briefly gone or busy, as while the OS or the browser re-lists its cameras); a refusal, or the
   * camera ending meanwhile, is final at once.
   */
  private async acquire(gum: (c: MediaStreamConstraints) => Promise<MediaStream>): Promise<MediaStream> {
    const waits = this.deps.retryDelaysMs ?? CAMERA_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await gum(cameraConstraints(this.snap.facing));
      } catch (e) {
        const wait = waits[attempt];
        if (wait === undefined || this.ended || !PASSING_GUM_FAILURES.has((e as { name?: string }).name ?? '')) throw e;
        await new Promise((r) => setTimeout(r, wait));
        if (this.ended) throw e;
      }
    }
  }

  private gum(): ((c: MediaStreamConstraints) => Promise<MediaStream>) | null {
    return (
      this.deps.getUserMedia ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
        : null)
    );
  }

  /**
   * `ended` on the live track means the browser or the OS ended the capture, never the person (their Stop, No thanks
   * and a switch go through `stop()` / `switchCamera()`, and `track.stop()` fires no `ended`): another app took the
   * camera, the device reset, or the browser restarted its capture. The person agreed to share, so the page takes the
   * same camera again and swaps it into the peer connections without renegotiating.
   */
  private watchTrack(track: MediaStreamTrack): void {
    track.addEventListener?.('ended', () => {
      if (this.stream?.getVideoTracks()[0] === track && !this.ended) void this.recoverTrack();
    });
  }

  /**
   * Takes the camera again after the browser ended it, at most `MAX_TRACK_RECOVERIES` times per camera; a camera that
   * cannot be taken again (refused, gone, or ending over and over) stops the camera with the reason it gives.
   */
  private async recoverTrack(): Promise<void> {
    if (this.recovering || this.ended) return;
    // A hidden page cannot take the camera (iOS ends the capture when the page goes to the background): it stops as
    // the person left it, as before.
    const doc = this.deps.doc ?? (typeof document !== 'undefined' ? document : null);
    if (doc?.visibilityState === 'hidden') return this.stop('phone_stopped');
    const gum = this.gum();
    if (!gum || this.recoveries >= MAX_TRACK_RECOVERIES) return this.stop('no_camera');
    this.recovering = true;
    this.recoveries += 1;
    try {
      let stream: MediaStream;
      try {
        stream = await this.acquire(gum);
      } catch (e) {
        return this.stop(gumFailure(e));
      }
      if (this.ended) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) return this.stop('no_camera');
      for (const t of this.stream?.getTracks() ?? []) t.stop();
      this.stream = stream;
      this.watchTrack(track);
      await this.sender?.replaceTrack(track).catch(() => undefined);
      await this.recSender?.replaceTrack(track).catch(() => undefined);
      this.updateTorch(track);
      this.set({ capture: this.snap.capture + 1 });
    } finally {
      this.recovering = false;
    }
  }

  private updateTorch(track: MediaStreamTrack): void {
    const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
    this.set({ torch: { available: caps.torch === true, on: false } });
  }

  private newPc(): RTCPeerConnection {
    const Impl = this.deps.PeerConnection ?? globalThis.RTCPeerConnection;
    return new Impl({ iceServers: (this.hello?.iceServers ?? []) as RTCIceServer[], bundlePolicy: 'max-bundle' });
  }

  private async offerToAssist(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    const hello = this.hello!;
    const pc = this.newPc();
    this.pc = pc;
    const dc = pc.createDataChannel('ia.cam', { negotiated: true, id: 0 });
    this.sec = new CamSecPhone(() => this.fingerprints(), this.deps.random);
    dc.onmessage = (ev: MessageEvent) => {
      const step = this.sec?.onFrame(parseSecFrame(ev.data));
      if (!step) return;
      if (step.send) dc.send(JSON.stringify(step.send));
      if (step.code) this.set({ securityCode: formatSecurityCode(step.code) });
      if (step.error) this.stop('error');
    };
    const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    this.sender = tx.sender;
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc) return;
      this.signal?.send({
        t: 'webrtc.ice',
        sessionId: hello.sessionId,
        candidate: ev.candidate ? (ev.candidate.toJSON() as IceCandidateInit) : null,
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && pc.connectionState === 'failed') void this.reoffer(pc, true);
    };
    await this.reoffer(pc, false);
  }

  private async reoffer(pc: RTCPeerConnection, iceRestart: boolean): Promise<void> {
    if (this.ended || this.pc !== pc || !this.hello) return;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp;
      if (sdp)
        this.signal?.send({
          t: 'webrtc.offer',
          sessionId: this.hello.sessionId,
          sdp,
          ...(iceRestart ? { restart: true } : {}),
        });
    } catch (e) {
      console.warn('[camera] offer failed', e);
    }
  }

  private fingerprints(): { offer: string; answer: string } | null {
    const offer = sdpFingerprint(this.pc?.localDescription?.sdp);
    const answer = sdpFingerprint(this.pc?.remoteDescription?.sdp);
    return offer && answer ? { offer, answer } : null;
  }

  private async onAnswer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c ?? undefined).catch(() => undefined);
      await this.capBitrate(this.sender);
    } catch (e) {
      console.warn('[camera] answer failed', e);
    }
  }

  private async capBitrate(sender: RTCRtpSender | null): Promise<void> {
    if (!sender?.getParameters || !sender.setParameters) return;
    try {
      const p = sender.getParameters();
      const enc = p.encodings && p.encodings.length > 0 ? p.encodings : [{}];
      enc[0]!.maxBitrate = (this.hello?.limits.maxBitrateKbps ?? LIMITS.cameraMaxBitrateKbps) * 1000;
      await sender.setParameters({ ...p, encodings: enc });
    } catch {
      /* not supported: the encoder's own limit applies */
    }
  }

  private async onIce(c: IceCandidateInit | null): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (!pc.remoteDescription) {
      this.pendingIce.push(c);
      return;
    }
    await pc.addIceCandidate(c ?? undefined).catch(() => undefined);
  }

  /** Section 6.5a: the recorder offers (as it does to a P1 Desk), the phone answers with the same camera track. */
  private async onRecorderOffer(sdp: string): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    const hello = this.hello;
    if (!track || !hello || this.ended || /^m=application/m.test(sdp)) return;
    this.recPc?.close();
    const pc = this.newPc();
    this.recPc = pc;
    this.recPendingIce = [];
    pc.onicecandidate = (ev) => {
      if (this.recPc !== pc) return;
      this.signal?.send({
        t: 'webrtc.ice',
        sessionId: hello.sessionId,
        candidate: ev.candidate ? (ev.candidate.toJSON() as IceCandidateInit) : null,
        peer: 'recorder',
      });
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const transceivers = pc.getTransceivers();
      const video = transceivers.find((t) => t.receiver.track?.kind === 'video');
      for (const t of transceivers) if (t !== video) t.direction = 'inactive';
      if (video) {
        video.direction = 'sendonly';
        await video.sender.replaceTrack(track);
        this.recSender = video.sender;
      } else {
        this.recSender = pc.addTrack(track, this.stream!);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const local = pc.localDescription?.sdp ?? answer.sdp;
      if (local) this.signal?.send({ t: 'webrtc.answer', sessionId: hello.sessionId, sdp: local, peer: 'recorder' });
      for (const c of this.recPendingIce.splice(0)) await pc.addIceCandidate(c ?? undefined).catch(() => undefined);
      await this.capBitrate(this.recSender);
    } catch (e) {
      console.warn('[camera] recorder negotiation failed', e);
    }
  }

  private async onRecorderIce(c: IceCandidateInit | null): Promise<void> {
    const pc = this.recPc;
    if (!pc) return;
    if (!pc.remoteDescription) {
      this.recPendingIce.push(c);
      return;
    }
    await pc.addIceCandidate(c ?? undefined).catch(() => undefined);
  }

  /** **Switch camera**: the other `facingMode`, swapped into both peer connections without renegotiation. */
  async switchCamera(): Promise<void> {
    if (this.snap.phase !== 'live') return;
    const next = this.snap.facing === 'environment' ? 'user' : 'environment';
    const gum = this.deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
    let stream: MediaStream;
    try {
      // Some phones open one camera at a time: release the current one first.
      for (const t of this.stream?.getTracks() ?? []) t.stop();
      stream = await gum(cameraConstraints(next));
    } catch {
      return this.stop('no_camera');
    }
    const track = stream.getVideoTracks()[0];
    if (!track) return this.stop('no_camera');
    this.stream = stream;
    this.watchTrack(track);
    await this.sender?.replaceTrack(track).catch(() => undefined);
    await this.recSender?.replaceTrack(track).catch(() => undefined);
    this.updateTorch(track);
    this.set({ facing: next, capture: this.snap.capture + 1 });
  }

  /** **Light**: only offered when the track reports the `torch` capability. */
  async toggleTorch(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.snap.torch.available) return;
    const on = !this.snap.torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      this.set({ torch: { available: true, on } });
    } catch {
      /* the light could not be changed */
    }
  }

  private onVisibility(state: DocumentVisibilityState): void {
    if (state === 'hidden') {
      if (this.hiddenTimer || this.snap.phase !== 'live') return;
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        if (this.snap.phase === 'live') this.stop('phone_stopped');
      }, this.deps.hiddenStopMs ?? 60_000);
    } else if (this.hiddenTimer) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  }

  /** **Stop** (or a refusal / failure on the phone): tells the server and releases the camera. */
  stop(reason: CameraStopReason): void {
    if (this.ended) return;
    if (this.hello) this.signal?.send({ t: 'camera.stop', cameraId: this.hello.cameraId, reason });
    this.finish(reason, true);
  }

  private finish(reason: CameraStopReason, closeSignal: boolean): void {
    if (this.ended) return;
    this.teardown();
    this.set({ phase: 'ended', endedReason: reason, message: endedText(reason), securityCode: null });
    if (closeSignal) this.signal?.close();
    else this.signal?.close(1000);
  }

  private teardown(): void {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.pc?.close();
    this.recPc?.close();
    this.pc = null;
    this.recPc = null;
    this.sender = null;
    this.recSender = null;
    this.sec = null;
  }

  /** Page unmount. */
  dispose(): void {
    if (!this.ended && this.snap.phase !== 'connecting' && this.hello) this.stop('phone_stopped');
    this.teardown();
    for (const off of this.offs.splice(0)) off();
    this.signal?.close();
  }

  /** The live camera stream, for the page's own preview. */
  get preview(): MediaStream | null {
    return this.stream;
  }
}

/** How many times one camera is taken again after the browser ended it (see `recoverTrack`). */
export const MAX_TRACK_RECOVERIES = 3;

/** The stop reason a failed `getUserMedia` gives. */
function gumFailure(e: unknown): CameraStopReason {
  const name = (e as { name?: string }).name;
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission_denied' : 'no_camera';
}

function clampDim(n: number): number {
  return Math.max(1, Math.min(8192, Math.round(n)));
}
