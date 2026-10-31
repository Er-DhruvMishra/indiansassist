/**
 * The data channels of one P3 peer connection (docs/specs/phase-c-contracts.md section 1.3): `ia.sec` carries the
 * plaintext handshake (shared `SecHandshake`); every other label is framed with the shared `SecChannel`
 * (XChaCha20-Poly1305, per key generation). Nothing is sent before `established`; frames that arrive while our own
 * confirm is still being verified are held (SCTP streams are not ordered across channels) and replayed after.
 * Channel lifetime rule: a second channel with the same label, an unknown label, or a close of an encrypted channel
 * while the connection lives is `sec.fail { reason: 'channel' }`. Implements `HubLike` so the file transfer layer
 * runs unchanged on top of it.
 *
 * Orderly end versus violation: per A section 7.4 hard rule 2 the Desk closes its channels and its connection
 * before (or right after) sending `stop.sharing` / `consent.revoked` and its WS end frame, so those closes are not
 * channel violations. Once either message has been opened on a channel, or the owner reports an orderly end
 * (`isOrderlyEnd`), or the connection itself is no longer alive, a close is ignored. The decision on a close is
 * deferred by one macrotask and re-checked, so a stop message that arrives on another channel in the same tick as
 * the close (SCTP orders per stream only) is processed first.
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
  /**
   * True once the session is ending in order (a `session.ended` / `desk.consent revoked` arrived over signaling, or
   * the console itself ended): later channel closes are teardown, not `sec.fail { reason: 'channel' }`.
   */
  isOrderlyEnd?: () => boolean;
  /** False once the peer connection is `closed` / `failed`; the channel lifetime rule only applies while it lives. */
  connectionAlive?: () => boolean;
  /**
   * F9: how long a channel close with no stop message waits for a server-initiated end (`session.ended` /
   * `consent.changed`) to be recognised as orderly before it is declared `sec.fail { reason: 'channel' }`. The Desk's
   * P2P close can beat the console's WS `session.ended`; without this window the race is mis-recorded as a channel
   * violation. Defaults to `CHANNEL_CLOSE_GRACE_MS`.
   */
  channelCloseGraceMs?: number;
  /** Injected in tests (fixed keys, no timer). */
  handshake?: (send: (m: SecMessage) => void, fpr: { own: string; remote: string }) => SecHandshake;
};

const HOLD_MAX = 512;
/** F9 default grace: a server-initiated end has this long to arrive before a channel close is a violation. */
export const CHANNEL_CLOSE_GRACE_MS = 1500;
/** Inbound messages that announce the Desk's hard rule 2 teardown (A section 8.1, `ia.ctrl`). */
const PEER_END_MESSAGES: ReadonlySet<string> = new Set(['stop.sharing', 'consent.revoked']);

export class SecureHub implements HubLike {
  private readonly channels = new Map<string, RTCDataChannel>();
  private handlers = new Set<MsgHandler>();
  private binHandlers = new Set<BinHandler>();
  private openHandlers = new Set<() => void>();
  private held: { label: SecEncryptedLabel; data: ArrayBuffer }[] = [];
  private hs: SecHandshake | null = null;
  private failed = false;
  private closing = false;
  private peerEnd: 'stop.sharing' | 'consent.revoked' | null = null;
  private closeTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly o: SecureHubOptions) {}

  get established(): boolean {
    return this.hs?.state === 'established';
  }

  get handshake(): SecHandshake | null {
    return this.hs;
  }

  /** The Desk's end announcement seen on a channel (`stop.sharing` / `consent.revoked`), else null. */
  get peerEnded(): 'stop.sharing' | 'consent.revoked' | null {
    return this.peerEnd;
  }

  /** Whether a close now would be part of an orderly end rather than a channel violation. */
  private closeIsOrderly(): boolean {
    return this.closing || this.failed || this.peerEnd !== null || this.o.isOrderlyEnd?.() === true || this.o.connectionAlive?.() === false;
  }

  /**
   * Channel lifetime rule, decided after a grace window rather than at once. A same-tick stop message is seen first
   * (as before), and additionally a server-initiated end whose `session.ended` / `consent.changed` is still in flight
   * over the WS has this long to arrive and make the close orderly (F9): the Desk tears its P2P down before its WS end
   * frame reaches the server, so the close can beat the end. When the end is recognised the owner tears the link down
   * (`close()`), which clears this timer, so the grace never ends in a false `sec.fail { reason: 'channel' }`.
   */
  private onChannelClose(): void {
    if (this.closeIsOrderly()) return;
    const timer = setTimeout(() => {
      this.closeTimers.delete(timer);
      if (!this.closeIsOrderly()) this.fail('channel');
    }, this.o.channelCloseGraceMs ?? CHANNEL_CLOSE_GRACE_MS);
    this.closeTimers.add(timer);
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
      if (isSecEncryptedLabel(label)) this.onChannelClose();
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
    if (PEER_END_MESSAGES.has(parsed.msg.t)) this.peerEnd = parsed.msg.t as 'stop.sharing' | 'consent.revoked';
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
    for (const t of this.closeTimers) clearTimeout(t);
    this.closeTimers.clear();
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
