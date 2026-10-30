/**
 * The data channels of one P3 peer connection (docs/specs/phase-c-contracts.md section 1.3): `ia.sec` carries the
 * plaintext handshake (shared `SecHandshake`); every other label is framed with the shared `SecChannel`
 * (XChaCha20-Poly1305, per key generation). Nothing is sent before `established`; frames that arrive while our own
 * confirm is still being verified are held (SCTP streams are not ordered across channels) and replayed after.
 * Channel lifetime rule: a second channel with the same label, an unknown label, or a close of an encrypted channel
 * while the connection lives is `sec.fail { reason: 'channel' }`. Implements `HubLike` so the file transfer layer
 * runs unchanged on top of it.
 */
import {
  P3_DATA_CHANNEL_LABELS,
  SecError,
  SecHandshake,
  isSecEncryptedLabel,
  parseDataChannelMessage,
  type AgentControlMessage,
  type DataChannelLabel,
  type DataChannelMessage,
  type SecEncryptedLabel,
  type SecEstablished,
  type SecFailReason,
  type SecMessage,
} from '@indiansassist/shared';
import { channelFor, type HubLike } from './channels';

export type InboundMessage = DataChannelMessage | AgentControlMessage;
type MsgHandler = (msg: InboundMessage) => void;
type BinHandler = (data: ArrayBuffer) => void;

export type SecureHubOptions = {
  sessionId: string;
  gen: number;
  /** Own / remote DTLS fingerprints from the current descriptions (null while not yet known). */
  fingerprints: () => { own: string; remote: string } | null;
  onEstablished: (r: SecEstablished) => void;
  /** A failure (sent or received): the caller writes `sec.failed` and ends the session (step 9). */
  onFailed: (reason: SecFailReason) => void;
  /** Injected in tests (fixed keys, no timer). */
  handshake?: (send: (m: SecMessage) => void, fpr: { own: string; remote: string }) => SecHandshake;
};

const HOLD_MAX = 512;

export class SecureHub implements HubLike {
  private readonly channels = new Map<string, RTCDataChannel>();
  private handlers = new Set<MsgHandler>();
  private binHandlers = new Set<BinHandler>();
  private openHandlers = new Set<() => void>();
  private held: { label: SecEncryptedLabel; data: ArrayBuffer }[] = [];
  private hs: SecHandshake | null = null;
  private failed = false;
  private closing = false;

  constructor(private readonly o: SecureHubOptions) {}

  get established(): boolean {
    return this.hs?.state === 'established';
  }

  get handshake(): SecHandshake | null {
    return this.hs;
  }

  attach(label: string, ch: RTCDataChannel): void {
    if (!(P3_DATA_CHANNEL_LABELS as readonly string[]).includes(label) || this.channels.has(label)) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
      return this.fail('channel');
    }
    this.channels.set(label, ch);
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (ev: MessageEvent) => this.receiveFrame(label, ev.data);
    ch.addEventListener('close', () => {
      if (!this.closing && isSecEncryptedLabel(label)) this.fail('channel');
    });
    if (label === 'ia.sec') {
      if (ch.readyState === 'open') queueMicrotask(() => this.startHandshake());
      else ch.addEventListener('open', () => this.startHandshake());
    }
  }

  private startHandshake(): void {
    if (this.hs || this.failed) return;
    const fpr = this.o.fingerprints();
    const sec = this.channels.get('ia.sec');
    const send = (m: SecMessage) => {
      if (sec?.readyState === 'open') sec.send(JSON.stringify(m));
    };
    if (!fpr) {
      this.failed = true;
      send({ t: 'sec.fail', reason: 'fingerprint', ts: Date.now() });
      return this.o.onFailed('fingerprint');
    }
    const hs =
      this.o.handshake?.(send, fpr) ??
      new SecHandshake({ side: 'assist', sessionId: this.o.sessionId, gen: this.o.gen, ownFpr: fpr.own, remoteFpr: fpr.remote, send });
    this.hs = hs;
    hs.onEstablished = (r) => {
      this.o.onEstablished(r);
      const held = this.held;
      this.held = [];
      for (const f of held) this.openFrame(f.label, f.data);
      for (const h of [...this.openHandlers]) h();
    };
    hs.onFailed = (reason) => {
      if (this.failed) return;
      this.failed = true;
      this.o.onFailed(reason);
    };
    hs.start();
  }

  private receiveFrame(label: string, data: unknown): void {
    if (this.failed) return;
    if (label === 'ia.sec') {
      if (typeof data === 'string') this.hs?.receive(data);
      return;
    }
    if (!isSecEncryptedLabel(label) || !(data instanceof ArrayBuffer)) return this.fail('decrypt');
    if (!this.established) {
      // Our confirm may still be in flight while the Desk already sends (no cross-channel order in SCTP).
      if (this.hs?.state !== 'confirming' || this.held.length >= HOLD_MAX) return this.fail('decrypt');
      this.held.push({ label, data });
      return;
    }
    this.openFrame(label, data);
  }

  private openFrame(label: SecEncryptedLabel, data: ArrayBuffer): void {
    let opened: { text: string | null; bytes: Uint8Array };
    try {
      opened = this.hs!.channel(label).open(new Uint8Array(data));
    } catch (e) {
      return this.fail(e instanceof SecError ? e.reason : 'decrypt');
    }
    if (opened.text === null) {
      if (label === 'ia.file') {
        const copy = opened.bytes.slice().buffer;
        for (const h of [...this.binHandlers]) h(copy);
      }
      return;
    }
    const parsed = parseDataChannelMessage(label, opened.text, 'desk');
    if (!parsed.ok) {
      console.warn('[sec] dropped message on', label, parsed.reason);
      return;
    }
    for (const h of [...this.handlers]) h(parsed.msg);
  }

  /** Sends `sec.fail` (when the handshake runs) and reports the failure once. */
  fail(reason: SecFailReason): void {
    if (this.failed) return;
    if (this.hs && this.hs.state !== 'failed') {
      this.hs.fail(reason);
      return;
    }
    this.failed = true;
    const sec = this.channels.get('ia.sec');
    if (sec?.readyState === 'open') sec.send(JSON.stringify({ t: 'sec.fail', reason, ts: Date.now() }));
    this.o.onFailed(reason);
  }

  get(label: DataChannelLabel): RTCDataChannel | undefined {
    return this.channels.get(label);
  }

  /** Seals and sends one JSON message on its channel; false before `established` or when the channel is closed. */
  send(msg: DataChannelMessage | AgentControlMessage): boolean {
    const label = channelFor(msg.t as DataChannelMessage['t']);
    return this.sendRaw(label, JSON.stringify(msg));
  }

  sendBinary(frame: Uint8Array): boolean {
    return this.sendRaw('ia.file', frame);
  }

  private sendRaw(label: string, plaintext: string | Uint8Array): boolean {
    if (!this.established || this.failed || !isSecEncryptedLabel(label)) return false;
    const ch = this.channels.get(label);
    if (!ch || ch.readyState !== 'open') return false;
    try {
      ch.send(this.hs!.channel(label).seal(plaintext) as Uint8Array<ArrayBuffer>);
      return true;
    } catch (e) {
      if (e instanceof SecError) this.fail(e.reason);
      return false;
    }
  }

  isOpen(label: SecEncryptedLabel): boolean {
    return this.established && this.channels.get(label)?.readyState === 'open';
  }

  onAny(h: MsgHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** HubLike: the file transfer layer only reads the A section 8.3 messages from this. */
  onMessage(h: (msg: DataChannelMessage) => void): () => void {
    return this.onAny(h as MsgHandler);
  }

  onBinary(h: BinHandler): () => void {
    this.binHandlers.add(h);
    return () => this.binHandlers.delete(h);
  }

  /** Fires once the keys are established (every encrypted channel is usable from then on). */
  onEstablished(h: () => void): () => void {
    this.openHandlers.add(h);
    return () => this.openHandlers.delete(h);
  }

  /** Hard rule 2 / rebuild: the closes that follow are not channel violations; old keys are zeroised. */
  close(): void {
    this.closing = true;
    for (const ch of this.channels.values()) {
      ch.onmessage = null;
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
    this.channels.clear();
    this.hs?.dispose();
    this.handlers.clear();
    this.binHandlers.clear();
    this.openHandlers.clear();
  }
}
