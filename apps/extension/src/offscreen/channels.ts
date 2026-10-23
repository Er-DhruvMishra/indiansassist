/**
 * The six data channels on the offscreen side (section 4.2): `ia.file` is handled here (file engine), mirror acks
 * and nacks go to the mirror sender, everything else is parsed JSON forwarded to the worker, which validates it
 * per label. Outbound JSON uses the channel when open, else the WS relay when allowed (`ia.control` as
 * `control.relay` at most 10 / s, `ia.mirror` JSON as a `kind: 'json'` relay part), else it is dropped.
 */
import { LIMITS, dcMirrorAckSchema, dcMirrorNackSchema, type DataChannelLabel } from '@indiansassist/shared';
import type { FileEngine } from './files';
import type { MirrorSender } from './mirror-sender';
import { fromBase64url, relayJson, type RelayPacer } from './relay-pacer';

export type ChannelDeps = {
  toWorker: (msg: { t: string } & Record<string, unknown>) => void;
  files: FileEngine;
  mirror: MirrorSender;
  relay: RelayPacer;
  relayAllowed: () => boolean;
  /** A live channel of the current peer connection closed (arms the relay fallback mid-session, 4.6). */
  onClosed?: (label: DataChannelLabel) => void;
  now?: () => number;
};

export class OffscreenChannels {
  readonly channels = new Map<DataChannelLabel, RTCDataChannel>();
  private controlSent: number[] = [];

  constructor(private readonly d: ChannelDeps) {}

  isOpen(label: DataChannelLabel): boolean {
    return this.channels.get(label)?.readyState === 'open';
  }

  get(label: DataChannelLabel): RTCDataChannel | null {
    const ch = this.channels.get(label);
    return ch && ch.readyState === 'open' ? ch : null;
  }

  attach(label: DataChannelLabel, ch: RTCDataChannel): void {
    this.channels.set(label, ch);
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => {
      this.d.toWorker({ t: 'dc.open', label });
      if (label === 'ia.mirror') this.d.mirror.channelOpened();
    };
    ch.onclose = () => {
      if (this.channels.get(label) !== ch) return;
      this.d.toWorker({ t: 'dc.close', label });
      this.d.onClosed?.(label);
      if (label === 'ia.mirror' && this.d.relayAllowed()) this.d.mirror.setTransport('relay');
    };
    ch.onmessage = (ev: MessageEvent) => this.onMessage(label, ev.data);
  }

  private onMessage(label: DataChannelLabel, data: unknown): void {
    if (typeof data !== 'string') {
      if (label === 'ia.file' && data instanceof ArrayBuffer) this.d.files.onBinary(data);
      return;
    }
    if (label === 'ia.file') return this.d.files.onText(data);
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (label === 'ia.mirror') return this.mirrorControl(msg);
    this.d.toWorker({ t: 'dc.msg', label, msg });
  }

  /** `mirror.ack` / `mirror.nack` from the Assist (over the channel or the relay); nothing else is accepted. */
  mirrorControl(msg: unknown): void {
    const ack = dcMirrorAckSchema.safeParse(msg);
    if (ack.success) return this.d.mirror.ack(ack.data.tabId);
    const nack = dcMirrorNackSchema.safeParse(msg);
    if (nack.success) this.d.mirror.nack(nack.data.tabId);
  }

  /** A `mirror.relay` from the Assist via the worker: only `kind: 'json'` acks / nacks are meaningful. */
  relayInbound(frame: Record<string, unknown>): void {
    if (frame.t !== 'mirror.relay' || frame.kind !== 'json' || typeof frame.data !== 'string') return;
    try {
      this.mirrorControl(JSON.parse(new TextDecoder().decode(fromBase64url(frame.data))));
    } catch {
      /* drop */
    }
  }

  sendJson(label: DataChannelLabel, msg: Record<string, unknown>): boolean {
    const ch = this.get(label);
    const text = JSON.stringify(msg);
    if (ch) {
      ch.send(text);
      return true;
    }
    if (!this.d.relayAllowed()) return false;
    if (label === 'ia.control') {
      const now = (this.d.now ?? Date.now)();
      this.controlSent = this.controlSent.filter((t) => now - t < 1000);
      if (this.controlSent.length >= LIMITS.controlRelayPerSec || text.length > LIMITS.controlRelayMaxBytes) return false;
      this.controlSent.push(now);
      this.d.toWorker({ t: 'relay.frame', msg: { t: 'control.relay', msg } });
      return true;
    }
    if (label === 'ia.mirror') {
      const frame = relayJson(text);
      if (!frame) return false;
      this.d.relay.enqueue([frame]);
      return true;
    }
    return false;
  }

  sendBinary(label: DataChannelLabel, data: ArrayBuffer | Uint8Array): boolean {
    const ch = this.get(label);
    if (!ch) return false;
    ch.send(data as ArrayBuffer);
    return true;
  }

  clear(): void {
    for (const ch of this.channels.values()) {
      ch.onopen = null;
      ch.onclose = null;
      ch.onmessage = null;
    }
    this.channels.clear();
  }
}
