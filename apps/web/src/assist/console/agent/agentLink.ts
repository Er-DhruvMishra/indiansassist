/**
 * One P3 peer connection of one key generation (docs/specs/phase-c-contracts.md sections 1.3, 3.7): the Desk (the
 * agent, impolite) offers with one `m=video` per consented monitor and creates the seven channels; the console
 * answers, attaches every channel to a `SecureHub` and runs the A section 8.3 file transfer over it. A rebuild
 * (`webrtc.offer { restart: true, gen }`) closes this link and builds a new one; channels are never re-created on a
 * live connection.
 */
import { fingerprintFromSdp, type SecEstablished, type SecFailReason } from '@indiansassist/shared';
import { FileTransfer, type AttestFn, type Transfer } from '../../../lib/fileTransfer';
import { PeerSession, type SignalOut } from '../../../lib/peer';
import { SecureHub, type InboundMessage, type SecureHubOptions } from '../../../lib/secureHub';
import type { SignalClient } from '../../../lib/signal';
import { NATIVE_SEND_OPTIONS } from '../../../lib/streamingFile';

export type AgentLinkEvents = {
  onTrack: (track: MediaStreamTrack, streams: readonly MediaStream[], mid: string | null) => void;
  onConnectionState: (s: RTCPeerConnectionState) => void;
  onEstablished: (r: SecEstablished) => void;
  onFailed: (reason: SecFailReason) => void;
  onMessage: (m: InboundMessage) => void;
  onTransfers: (list: Transfer[]) => void;
};

export type AgentLinkOptions = {
  sessionId: string;
  gen: number;
  iceServers: RTCIceServer[];
  signal: SignalClient;
  attest: AttestFn;
  events: AgentLinkEvents;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
  /** Injected in tests (the fake connection has no descriptions). */
  fingerprints?: () => { own: string; remote: string } | null;
  handshake?: SecureHubOptions['handshake'];
};

export class AgentLink {
  readonly peer: PeerSession;
  readonly hub: SecureHub;
  readonly files: FileTransfer;
  private closed = false;
  private unsub: () => void;

  constructor(readonly o: AgentLinkOptions) {
    this.hub = new SecureHub({
      sessionId: o.sessionId,
      gen: o.gen,
      fingerprints: o.fingerprints ?? (() => this.descriptionFingerprints()),
      onEstablished: (r) => o.events.onEstablished(r),
      onFailed: (r) => o.events.onFailed(r),
      handshake: o.handshake,
    });
    this.files = new FileTransfer(this.hub, 'assist', (l) => o.events.onTransfers(l), o.attest, NATIVE_SEND_OPTIONS);
    this.unsub = this.hub.onAny((m) => o.events.onMessage(m));
    this.peer = new PeerSession({
      polite: true,
      iceServers: o.iceServers,
      send: (m) => this.sendSignal(m),
      onTrack: (t, s, mid) => o.events.onTrack(t, s, mid),
      onChannel: (label, ch) => this.hub.attach(label, ch),
      onConnectionState: (s) => o.events.onConnectionState(s),
      RTCPeerConnectionImpl: o.RTCPeerConnectionImpl,
    });
  }

  /** Section 1.3 step 1: own = currentLocalDescription, remote = currentRemoteDescription, each normalised. */
  private descriptionFingerprints(): { own: string; remote: string } | null {
    const pc = this.peer.pc as RTCPeerConnection & { currentLocalDescription?: RTCSessionDescription | null; currentRemoteDescription?: RTCSessionDescription | null };
    const own = fingerprintFromSdp((pc.currentLocalDescription ?? pc.localDescription)?.sdp ?? '');
    const remote = fingerprintFromSdp((pc.currentRemoteDescription ?? pc.remoteDescription)?.sdp ?? '');
    return own && remote ? { own, remote } : null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private sendSignal(m: SignalOut): void {
    if (this.closed) return;
    const sessionId = this.o.sessionId;
    if (m.t === 'webrtc.ice') this.o.signal.send({ t: 'webrtc.ice', sessionId, candidate: m.candidate });
    else this.o.signal.send({ t: m.t, sessionId, sdp: m.sdp });
  }

  handleSignal(m: SignalOut): Promise<void> {
    return this.peer.handleSignal(m);
  }

  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.peer.addTrack(track, stream, { keep: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsub();
    this.files.dispose();
    this.hub.close();
    this.peer.close();
  }
}
