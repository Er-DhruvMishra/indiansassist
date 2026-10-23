/**
 * Typed send / receive over the data channels (contracts section 8; Phase B 4.2 adds `ia.mirror` and
 * `ia.control`). Inbound JSON is validated with the shared `parseDataChannelMessage` (wrong channel or a
 * `from` that is not the peer is dropped); binary frames on `ia.file` are handed to the file transfer layer
 * and binary frames on `ia.mirror` (fragmented rrweb batches, Phase B 4.5) to the mirror receiver, untouched.
 */
import {
  parseDataChannelMessage,
  type DataChannelLabel,
  type DataChannelMessage,
  type Side,
} from '@indiansassist/shared';

type MsgHandler = (msg: DataChannelMessage) => void;
type BinHandler = (data: ArrayBuffer) => void;

/** Which channel each outbound `t` travels on. */
export function channelFor(t: DataChannelMessage['t']): DataChannelLabel {
  if (t === 'chat' || t === 'chat.ack' || t === 'typing') return 'ia.chat';
  if (t === 'annot') return 'ia.annot';
  if (t.startsWith('file.')) return 'ia.file';
  if (t.startsWith('mirror.')) return 'ia.mirror';
  if (t.startsWith('ctl.')) return 'ia.control';
  return 'ia.ctrl';
}

export class ChannelHub {
  private channels = new Map<DataChannelLabel, RTCDataChannel>();
  private handlers = new Set<MsgHandler>();
  private binHandlers = new Set<BinHandler>();
  private mirrorBinHandlers = new Set<BinHandler>();
  /** Bytes received per channel (JSON text length or binary length), for the mirror kbps readout. */
  readonly bytesIn = new Map<DataChannelLabel, number>();
  private openHandlers = new Set<(label: DataChannelLabel) => void>();

  /** `peer` is the other side; messages whose `from` is not the peer are dropped. */
  constructor(private readonly peer: Side) {}

  attach(label: DataChannelLabel, ch: RTCDataChannel): void {
    this.channels.set(label, ch);
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (ev: MessageEvent) => {
      const size = typeof ev.data === 'string' ? ev.data.length : ev.data instanceof ArrayBuffer ? ev.data.byteLength : 0;
      this.bytesIn.set(label, (this.bytesIn.get(label) ?? 0) + size);
      if (typeof ev.data === 'string') {
        const parsed = parseDataChannelMessage(label, ev.data, this.peer);
        if (!parsed.ok) {
          console.warn('[dc] dropped message on', label, parsed.reason);
          return;
        }
        for (const h of [...this.handlers]) h(parsed.msg);
      } else if (label === 'ia.file' && ev.data instanceof ArrayBuffer) {
        for (const h of [...this.binHandlers]) h(ev.data);
      } else if (label === 'ia.mirror' && ev.data instanceof ArrayBuffer) {
        for (const h of [...this.mirrorBinHandlers]) h(ev.data);
      }
    };
    const fireOpen = () => {
      for (const h of [...this.openHandlers]) h(label);
    };
    if (ch.readyState === 'open') queueMicrotask(fireOpen);
    else ch.addEventListener('open', fireOpen);
  }

  get(label: DataChannelLabel): RTCDataChannel | undefined {
    return this.channels.get(label);
  }

  isOpen(label: DataChannelLabel): boolean {
    return this.channels.get(label)?.readyState === 'open';
  }

  /** Sends a JSON message on its channel; returns false when the channel is not open. */
  send(msg: DataChannelMessage): boolean {
    const ch = this.channels.get(channelFor(msg.t));
    if (!ch || ch.readyState !== 'open') return false;
    ch.send(JSON.stringify(msg));
    return true;
  }

  sendBinary(frame: Uint8Array): boolean {
    const ch = this.channels.get('ia.file');
    if (!ch || ch.readyState !== 'open') return false;
    ch.send(frame as Uint8Array<ArrayBuffer>);
    return true;
  }

  onMessage(h: MsgHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onBinary(h: BinHandler): () => void {
    this.binHandlers.add(h);
    return () => this.binHandlers.delete(h);
  }

  /** Binary parts on `ia.mirror` (Phase B 4.5). */
  onMirrorBinary(h: BinHandler): () => void {
    this.mirrorBinHandlers.add(h);
    return () => this.mirrorBinHandlers.delete(h);
  }

  onOpen(h: (label: DataChannelLabel) => void): () => void {
    this.openHandlers.add(h);
    return () => this.openHandlers.delete(h);
  }

  clear(): void {
    for (const ch of this.channels.values()) ch.onmessage = null;
    this.channels.clear();
  }
}
