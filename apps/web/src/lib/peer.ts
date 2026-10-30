/**
 * One RTCPeerConnection per session (contracts sections 7.7 and 8) with the perfect-negotiation pattern.
 * `polite` comes from `session.created` (Assist polite, Desk impolite). The Desk creates the data channels
 * before the first offer (the web Desk: the four P1 labels; the extension adds `ia.mirror` and `ia.control`,
 * Phase B 4.2); the Assist receives them via `ondatachannel` and accepts all six labels.
 *
 * `close()` implements hard rule 2 (section 7.4): stop every local track it was told to own, close every
 * data channel, `pc.close()`. Tracks passed with `{ keep: true }` (the Desk's capture track on an Assist
 * reconnect) survive a close so they can be re-added to the next connection.
 */
import { DATA_CHANNEL_LABELS, P1_DATA_CHANNEL_LABELS, type DataChannelLabel, type IceCandidateInit } from '@indiansassist/shared';

export type SignalOut =
  | { t: 'webrtc.offer'; sdp: string }
  | { t: 'webrtc.answer'; sdp: string }
  | { t: 'webrtc.ice'; candidate: IceCandidateInit | null };

export type PeerOptions = {
  polite: boolean;
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  send: (msg: SignalOut) => void;
  /** `mid` = the transceiver's SDP mid (Phase C section 3.6 M1 maps it to a monitor). */
  onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[], mid: string | null) => void;
  onChannel?: (label: DataChannelLabel, channel: RTCDataChannel) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  /** Injected in tests. */
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
};

export function peerConfig(iceServers: RTCIceServer[], policy: RTCIceTransportPolicy = 'all'): RTCConfiguration {
  return { iceServers, iceCandidatePoolSize: 2, bundlePolicy: 'max-bundle', iceTransportPolicy: policy };
}

function isLabel(x: string): x is DataChannelLabel {
  return (DATA_CHANNEL_LABELS as readonly string[]).includes(x);
}

export class PeerSession {
  readonly pc: RTCPeerConnection;
  readonly channels = new Map<DataChannelLabel, RTCDataChannel>();
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;
  private owned = new Set<MediaStreamTrack>();
  private senders = new Map<MediaStreamTrack, RTCRtpSender>();

  constructor(private readonly opts: PeerOptions) {
    const Impl = opts.RTCPeerConnectionImpl ?? globalThis.RTCPeerConnection;
    this.pc = new Impl(peerConfig(opts.iceServers, opts.iceTransportPolicy));
    this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.onicecandidate = (ev) => {
      if (this.closed) return;
      const c = ev.candidate;
      this.opts.send({ t: 'webrtc.ice', candidate: c ? (c.toJSON() as IceCandidateInit) : null });
    };
    this.pc.ontrack = (ev) => this.opts.onTrack?.(ev.track, ev.streams, ev.transceiver?.mid ?? null);
    this.pc.ondatachannel = (ev) => this.registerChannel(ev.channel);
    this.pc.onconnectionstatechange = () => this.opts.onConnectionState?.(this.pc.connectionState);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async negotiate(): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const sdp = this.pc.localDescription?.sdp;
      if (sdp && !this.closed) this.opts.send({ t: 'webrtc.offer', sdp });
    } catch (e) {
      console.warn('[peer] negotiation failed', e);
    } finally {
      this.makingOffer = false;
    }
  }

  private registerChannel(ch: RTCDataChannel): void {
    if (!isLabel(ch.label)) return;
    ch.binaryType = 'arraybuffer';
    this.channels.set(ch.label, ch);
    this.opts.onChannel?.(ch.label, ch);
  }

  /** Desk: creates `ia.chat`, `ia.annot`, `ia.file`, `ia.ctrl` (ordered, reliable) before the first offer. */
  createDataChannels(labels: readonly DataChannelLabel[] = P1_DATA_CHANNEL_LABELS): void {
    for (const label of labels) {
      const ch = this.pc.createDataChannel(label, { ordered: true });
      this.registerChannel(ch);
    }
  }

  /** Adds a local track. `keep` tracks are not stopped by `close()` (they are re-used after a reconnect). */
  addTrack(track: MediaStreamTrack, stream: MediaStream, opts: { keep?: boolean } = {}): void {
    if (this.closed) return;
    if (!opts.keep) this.owned.add(track);
    this.senders.set(track, this.pc.addTrack(track, stream));
  }

  removeTrack(track: MediaStreamTrack): void {
    const sender = this.senders.get(track);
    if (sender && !this.closed) {
      try {
        this.pc.removeTrack(sender);
      } catch {
        /* already gone */
      }
    }
    this.senders.delete(track);
    this.owned.delete(track);
  }

  /** Handles a relayed `webrtc.offer` / `webrtc.answer` / `webrtc.ice` (perfect negotiation). */
  async handleSignal(msg: SignalOut): Promise<void> {
    if (this.closed) return;
    try {
      if (msg.t === 'webrtc.ice') {
        try {
          await this.pc.addIceCandidate(msg.candidate ?? undefined);
        } catch (e) {
          if (!this.ignoreOffer) throw e;
        }
        return;
      }
      const description: RTCSessionDescriptionInit = {
        type: msg.t === 'webrtc.offer' ? 'offer' : 'answer',
        sdp: msg.sdp,
      };
      const offerCollision =
        description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.opts.polite && offerCollision;
      if (this.ignoreOffer) return;
      await this.pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        const sdp = this.pc.localDescription?.sdp;
        if (sdp && !this.closed) this.opts.send({ t: 'webrtc.answer', sdp });
      }
    } catch (e) {
      console.warn('[peer] signal handling failed', e);
    }
  }

  /** `ice.refresh` (section 6.11): apply new servers; only the impolite side (Desk) restarts ICE. */
  refreshIce(iceServers: RTCIceServer[], restart: boolean): void {
    if (this.closed) return;
    this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    if (restart) this.pc.restartIce();
  }

  /** Media path recovery (correctness-F6): new ICE credentials; `negotiationneeded` sends the offer. */
  restartIce(): void {
    if (this.closed) return;
    this.pc.restartIce();
  }

  setTransportPolicy(policy: RTCIceTransportPolicy): void {
    if (this.closed) return;
    this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceTransportPolicy: policy });
    this.pc.restartIce();
  }

  getStats(): Promise<RTCStatsReport> {
    return this.pc.getStats();
  }

  /** Hard rule 2: stop owned local tracks, close every data channel, close the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.owned) t.stop();
    this.owned.clear();
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
    this.pc.ondatachannel = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }
}

/** Shared ICE servers -> RTCIceServer[] (the shared schema allows string or string[] urls). */
export function toRtcIceServers(servers: { urls: string | string[]; username?: string; credential?: string }[]): RTCIceServer[] {
  return servers.map((s) => {
    const out: RTCIceServer = { urls: s.urls };
    if (s.username !== undefined) out.username = s.username;
    if (s.credential !== undefined) out.credential = s.credential;
    return out;
  });
}
