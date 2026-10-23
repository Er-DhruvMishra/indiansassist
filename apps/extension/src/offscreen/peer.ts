/**
 * The Desk's RTCPeerConnection in the offscreen document (sections 3.5, 4.2, 7): perfect negotiation with the Desk
 * impolite (Phase A 7.7), six data channels created before the first offer, a brand-new connection on every
 * rebuild whose first offer carries `restart: true` (Y23), and media recovery: three ICE restarts, then
 * `rebuild.needed` (the relay carries traffic meanwhile).
 */
import { DATA_CHANNEL_LABELS, type DataChannelLabel } from '@indiansassist/shared';

export type PeerSignalOut =
  | { t: 'webrtc.offer'; sdp: string; restart?: boolean }
  | { t: 'webrtc.answer'; sdp: string }
  | { t: 'webrtc.ice'; candidate: Record<string, unknown> | null };

export type PeerOptions = {
  iceServers: RTCIceServer[];
  /** True when this connection replaces an earlier one (resume or failed recovery): first offer has restart. */
  restart: boolean;
  send: (msg: PeerSignalOut) => void;
  onChannel: (label: DataChannelLabel, ch: RTCDataChannel) => void;
  onState: (state: RTCPeerConnectionState, path: 'unknown' | 'p2p' | 'relay') => void;
  onTrack: (track: MediaStreamTrack) => void;
  onGiveUp: () => void;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
};

const MAX_RESTARTS = 3;

export class DeskPeer {
  readonly pc: RTCPeerConnection;
  readonly channels = new Map<DataChannelLabel, RTCDataChannel>();
  private makingOffer = false;
  private closed = false;
  private firstOffer = true;
  private restarts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: PeerOptions) {
    const Impl = o.RTCPeerConnectionImpl ?? globalThis.RTCPeerConnection;
    this.pc = new Impl({ iceServers: o.iceServers, iceCandidatePoolSize: 2, bundlePolicy: 'max-bundle' });
    this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.onicecandidate = (ev) => {
      if (!this.closed) this.o.send({ t: 'webrtc.ice', candidate: ev.candidate ? (ev.candidate.toJSON() as Record<string, unknown>) : null });
    };
    this.pc.ontrack = (ev) => this.o.onTrack(ev.track);
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    for (const label of DATA_CHANNEL_LABELS) {
      const ch = this.pc.createDataChannel(label, { ordered: true });
      ch.binaryType = 'arraybuffer';
      this.channels.set(label, ch);
      this.o.onChannel(label, ch);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Payload bytes per data-channel message: `min(maxMessageSize ?? 65536, 65536)` (section 4.5). */
  maxMessageSize(): number {
    const sctp = (this.pc as RTCPeerConnection & { sctp?: { maxMessageSize?: number } | null }).sctp;
    const m = sctp?.maxMessageSize;
    return typeof m === 'number' && m > 0 && Number.isFinite(m) ? m : 65536;
  }

  private async negotiate(): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const sdp = this.pc.localDescription?.sdp;
      if (sdp && !this.closed) {
        this.o.send({ t: 'webrtc.offer', sdp, ...(this.firstOffer && this.o.restart ? { restart: true } : {}) });
        this.firstOffer = false;
      }
    } catch (e) {
      console.warn('[peer] negotiation failed', e);
    } finally {
      this.makingOffer = false;
    }
  }

  /** A relayed `webrtc.answer` / `webrtc.offer` / `webrtc.ice` (the Desk is impolite: colliding offers are ignored). */
  async handle(msg: { t: string; sdp?: string; candidate?: RTCIceCandidateInit | null }): Promise<void> {
    if (this.closed) return;
    try {
      if (msg.t === 'webrtc.ice') {
        await this.pc.addIceCandidate(msg.candidate ?? undefined).catch(() => undefined);
        return;
      }
      const type = msg.t === 'webrtc.offer' ? 'offer' : 'answer';
      if (type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable')) return;
      await this.pc.setRemoteDescription({ type, sdp: msg.sdp ?? '' });
      if (type === 'offer') {
        await this.pc.setLocalDescription();
        const sdp = this.pc.localDescription?.sdp;
        if (sdp) this.o.send({ t: 'webrtc.answer', sdp });
      }
    } catch (e) {
      console.warn('[peer] signal failed', e);
    }
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    if (this.closed) return;
    this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    this.pc.restartIce();
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): RTCRtpSender | null {
    return this.closed ? null : this.pc.addTrack(track, stream);
  }

  private async onConnectionState(): Promise<void> {
    const st = this.pc.connectionState;
    this.o.onState(st, await this.path());
    if (st === 'connected') {
      this.restarts = 0;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    } else if (st === 'failed' || st === 'disconnected') this.scheduleRecovery(st === 'failed' ? 0 : 4000);
  }

  private scheduleRecovery(delay: number): void {
    if (this.recoveryTimer || this.closed) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.closed || this.pc.connectionState === 'connected') return;
      if (this.restarts >= MAX_RESTARTS) return this.o.onGiveUp();
      this.restarts++;
      this.pc.restartIce();
      this.scheduleRecovery(8000);
    }, delay);
  }

  private async path(): Promise<'unknown' | 'p2p' | 'relay'> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((r: { type: string; selectedCandidatePairId?: string }) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      const pair = pairId ? (stats.get(pairId) as { localCandidateId?: string } | undefined) : undefined;
      const local = pair?.localCandidateId ? (stats.get(pair.localCandidateId) as { candidateType?: string } | undefined) : undefined;
      if (!local?.candidateType) return 'unknown';
      return local.candidateType === 'relay' ? 'relay' : 'p2p';
    } catch {
      return 'unknown';
    }
  }

  /** Hard rule 2 for the connection: every channel closed, then the PC. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    for (const ch of this.channels.values()) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
    this.channels.clear();
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }
}
