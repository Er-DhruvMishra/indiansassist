/**
 * The Desk's second RTCPeerConnection, toward the server recorder (Phase A.2 sections 1 and 7, N3 / N4 / S3 / S4).
 * The recorder always offers (two `recvonly` transceivers, video then audio, no data channel); the Desk answers
 * with the SAME screen track the Assist connection sends and, when voice is on, the same microphone track.
 * Without a microphone the audio transceiver is set to `sendonly` with no track, so a microphone enabled later
 * is attached with `sender.replaceTrack(mic)` and no renegotiation. The Desk never offers to the recorder and
 * never restarts its ICE (the recorder sends a fresh offer instead). Closing never stops a track: the tracks
 * belong to the Desk controller (hard rule 2 stops them there).
 */
import { serverRecords, type IceCandidateInit, type RecordingMode } from '@indiansassist/shared';
import type { SignalClient } from '../lib/signal';

/** S4: a recorder offer that would open a data channel is refused. */
export function hasDataChannel(sdp: string): boolean {
  return /^m=application/m.test(sdp);
}

export type RecorderOfferContext = {
  sessionId: string | null;
  /** The Desk is sharing (session `active`). */
  sharing: boolean;
  recordingMode: RecordingMode | null | undefined;
  iceServers: RTCIceServer[];
  screen: MediaStream | null;
  mic: MediaStream | null;
};

/** Why an offer was ignored (logged locally, N3), or null when it was accepted. */
export function refuseReason(sdp: string, ctx: RecorderOfferContext): string | null {
  if (!ctx.sessionId || !ctx.sharing || !ctx.screen?.getVideoTracks()[0]) return 'not sharing';
  if (!serverRecords(ctx.recordingMode)) return 'recording mode does not allow the server recorder';
  if (hasDataChannel(sdp)) return 'offer contains a data channel';
  return null;
}

export class DeskRecorderPeer {
  private pc: RTCPeerConnection | null = null;
  private audioSender: RTCRtpSender | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private pendingIce: (IceCandidateInit | null)[] = [];
  private remoteSet = false;
  /** Bumped on every close so a negotiation in flight for an old connection stops at its next await. */
  private gen = 0;

  constructor(
    private readonly signal: SignalClient,
    private readonly Impl?: typeof RTCPeerConnection,
  ) {}

  get active(): boolean {
    return this.pc !== null;
  }

  /** N3: any accepted offer replaces the current recorder connection. Returns false when it was ignored. */
  async offer(sdp: string, ctx: RecorderOfferContext): Promise<boolean> {
    const why = refuseReason(sdp, ctx);
    if (why) {
      console.warn(`[recorder] offer ignored: ${why}`);
      return false;
    }
    this.close();
    const gen = this.gen;
    const sessionId = ctx.sessionId!;
    const screen = ctx.screen!;
    const Impl = this.Impl ?? globalThis.RTCPeerConnection;
    const pc = new Impl({ iceServers: ctx.iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc) return;
      const c = ev.candidate;
      this.signal.send({
        t: 'webrtc.ice',
        sessionId,
        candidate: c ? (c.toJSON() as IceCandidateInit) : null,
        peer: 'recorder',
      });
    };
    // The recorder is receive only; nothing it could send is used, and it has no data channel (S4).
    pc.ondatachannel = (ev) => ev.channel.close();
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      if (gen !== this.gen) return false;
      this.remoteSet = true;
      const video = screen.getVideoTracks()[0]!;
      pc.addTrack(video, screen);
      const micTrack = ctx.mic?.getAudioTracks()[0] ?? null;
      if (micTrack && ctx.mic) {
        this.audioSender = pc.addTrack(micTrack, ctx.mic);
        this.audioTrack = micTrack;
      } else {
        const audio = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio' && t.sender.track === null);
        if (audio) {
          audio.direction = 'sendonly';
          this.audioSender = audio.sender;
        }
      }
      const answer = await pc.createAnswer();
      if (gen !== this.gen) return false;
      await pc.setLocalDescription(answer);
      if (gen !== this.gen) return false;
      const local = pc.localDescription?.sdp ?? answer.sdp;
      if (local) this.signal.send({ t: 'webrtc.answer', sessionId, sdp: local, peer: 'recorder' });
      for (const c of this.pendingIce.splice(0)) await this.addCandidate(pc, c);
      return true;
    } catch (e) {
      console.warn('[recorder] negotiation failed', e);
      if (gen === this.gen) this.close();
      return false;
    }
  }

  /** The Desk never offers, so an answer is applied only to a local offer in flight (never in practice). */
  async answer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || pc.signalingState !== 'have-local-offer') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (e) {
      console.warn('[recorder] answer failed', e);
    }
  }

  /** Recorder-tagged ICE: dropped without a connection, queued until the offer is applied. */
  async ice(candidate: IceCandidateInit | null): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (!this.remoteSet) {
      this.pendingIce.push(candidate);
      return;
    }
    await this.addCandidate(pc, candidate);
  }

  private async addCandidate(pc: RTCPeerConnection, candidate: IceCandidateInit | null): Promise<void> {
    try {
      await pc.addIceCandidate(candidate ?? undefined);
    } catch (e) {
      console.warn('[recorder] ICE candidate rejected', e);
    }
  }

  /** Voice turned on / off on the Desk: the same track, attached without renegotiation (N3). */
  setMic(track: MediaStreamTrack | null): void {
    if (!this.pc || !this.audioSender || track === this.audioTrack) return;
    this.audioTrack = track;
    void this.audioSender.replaceTrack(track).catch((e: unknown) => console.warn('[recorder] replaceTrack failed', e));
  }

  /** N4: `ice.refresh` applies the new servers; the Desk never restarts the recorder's ICE. */
  refreshIce(iceServers: RTCIceServer[]): void {
    if (!this.pc) return;
    try {
      this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    } catch (e) {
      console.warn('[recorder] setConfiguration failed', e);
    }
  }

  /** S3: closes the connection; the shared tracks keep running for the Assist connection. Idempotent. */
  close(): void {
    this.gen += 1;
    this.pendingIce = [];
    this.remoteSet = false;
    this.audioSender = null;
    this.audioTrack = null;
    const pc = this.pc;
    this.pc = null;
    if (!pc) return;
    pc.onicecandidate = null;
    pc.ondatachannel = null;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
  }
}
