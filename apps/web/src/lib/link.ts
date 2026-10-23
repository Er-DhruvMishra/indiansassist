/**
 * PeerLink: one RTCPeerConnection plus its data channels and file transfer for one session (contracts
 * sections 7.7 and 8). Shared by the Assist console and the Desk room; the controllers own media tracks
 * and decide when to build and close a link (hard rule 2 is `close()` plus the controller stopping its
 * own tracks). Chat state lives in the controllers so it survives a link rebuild.
 */
import type {
  DataChannelLabel,
  DataChannelMessage,
  DcAnnot,
  DcChat,
  Side,
} from '@indiansassist/shared';
import { ChannelHub } from './channels';
import { FileTransfer, type AttestFn, type Transfer } from './fileTransfer';
import { PeerSession, type SignalOut } from './peer';
import type { SignalClient } from './signal';

export type CtrlMessage = Extract<
  DataChannelMessage,
  { t: 'stop.sharing' | 'consent.revoked' | 'recording.state' | 'voice.state' | 'ping' | 'pong' }
>;

/** JSON text frames the Desk sends on `ia.mirror` (Phase B 4.5); acks and nacks only travel the other way. */
export type MirrorJsonMessage = Extract<DataChannelMessage, { t: 'mirror.tabs' | 'mirror.tab' }>;
/** What the Desk sends on `ia.control` (Phase B 5.1); a `ctl.req` from the Desk is a wrong-direction drop. */
export type ControlInbound = Extract<DataChannelMessage, { t: 'ctl.res' | 'ctl.event' }>;

export type LinkEvents = {
  onMirrorJson?: (msg: MirrorJsonMessage) => void;
  onMirrorBinary?: (frame: ArrayBuffer) => void;
  onControl?: (msg: ControlInbound) => void;
  onChat?: (msg: DcChat) => void;
  onTyping?: (active: boolean) => void;
  onAnnot?: (msg: DcAnnot) => void;
  onCtrl?: (msg: CtrlMessage) => void;
  onTransfers?: (list: Transfer[]) => void;
  onTrack?: (track: MediaStreamTrack, streams: readonly MediaStream[]) => void;
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  onChannelOpen?: (label: DataChannelLabel) => void;
};

export type LinkOptions = {
  side: Side;
  sessionId: string;
  polite: boolean;
  iceServers: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  signal: SignalClient;
  /** The Desk creates the four channels before the first offer (section 8). */
  createChannels: boolean;
  attest: AttestFn;
  events: LinkEvents;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
};

export class PeerLink {
  readonly peer: PeerSession;
  readonly hub: ChannelHub;
  readonly files: FileTransfer;
  private unsub: () => void;
  private unsubOpen: () => void;
  private unsubMirror: () => void;
  private closed = false;

  constructor(private readonly opts: LinkOptions) {
    const peerSide: Side = opts.side === 'assist' ? 'desk' : 'assist';
    this.hub = new ChannelHub(peerSide);
    this.files = new FileTransfer(this.hub, opts.side, (l) => opts.events.onTransfers?.(l), opts.attest);
    this.unsub = this.hub.onMessage((m) => this.route(m));
    this.unsubOpen = this.hub.onOpen((label) => opts.events.onChannelOpen?.(label));
    this.unsubMirror = this.hub.onMirrorBinary((f) => opts.events.onMirrorBinary?.(f));
    this.peer = new PeerSession({
      polite: opts.polite,
      iceServers: opts.iceServers,
      iceTransportPolicy: opts.iceTransportPolicy,
      send: (m) => this.sendSignal(m),
      onTrack: (track, streams) => opts.events.onTrack?.(track, streams),
      onChannel: (label, ch) => this.hub.attach(label, ch),
      onConnectionState: (s) => opts.events.onConnectionState?.(s),
      RTCPeerConnectionImpl: opts.RTCPeerConnectionImpl,
    });
    if (opts.createChannels) this.peer.createDataChannels();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private sendSignal(m: SignalOut): void {
    if (this.closed) return;
    const sessionId = this.opts.sessionId;
    if (m.t === 'webrtc.ice') this.opts.signal.send({ t: 'webrtc.ice', sessionId, candidate: m.candidate });
    else this.opts.signal.send({ t: m.t, sessionId, sdp: m.sdp });
  }

  private route(m: DataChannelMessage): void {
    const ev = this.opts.events;
    switch (m.t) {
      case 'chat':
        ev.onChat?.(m);
        this.hub.send({ t: 'chat.ack', msgId: m.msgId, ts: Date.now() });
        return;
      case 'typing':
        ev.onTyping?.(m.active);
        return;
      case 'annot':
        ev.onAnnot?.(m);
        return;
      case 'ping':
        this.hub.send({ t: 'pong', ts: Date.now() });
        ev.onCtrl?.(m);
        return;
      case 'stop.sharing':
      case 'consent.revoked':
      case 'recording.state':
      case 'voice.state':
      case 'pong':
        ev.onCtrl?.(m);
        return;
      case 'mirror.tabs':
      case 'mirror.tab':
        ev.onMirrorJson?.(m);
        return;
      case 'ctl.res':
      case 'ctl.event':
        ev.onControl?.(m);
        return;
      default:
        return;
    }
  }

  /** Relayed `webrtc.*` from the server. */
  handleSignal(m: SignalOut): Promise<void> {
    return this.peer.handleSignal(m);
  }

  send(m: DataChannelMessage): boolean {
    return this.closed ? false : this.hub.send(m);
  }

  /** Controller-owned track: `close()` never stops it (the controller does, per hard rule 2). */
  addTrack(track: MediaStreamTrack, stream: MediaStream): void {
    this.peer.addTrack(track, stream, { keep: true });
  }

  removeTrack(track: MediaStreamTrack): void {
    this.peer.removeTrack(track);
  }

  /** Closes channels, disposes transfers and closes the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsub();
    this.unsubOpen();
    this.unsubMirror();
    this.files.dispose();
    this.hub.clear();
    this.peer.close();
  }
}

// ---------- chat model ----------

export type ChatItem = { msgId: string; from: Side; text: string; ts: number; mine: boolean };

/** Appends a message unless its msgId is already present (dc and WS relay de-duplication, section 8.1). */
export function addChat(list: readonly ChatItem[], item: ChatItem): ChatItem[] {
  if (list.some((c) => c.msgId === item.msgId)) return list as ChatItem[];
  return [...list, item];
}
