/**
 * Mirror frames out of the offscreen document (sections 4.3-4.6): every event sanitised (`sanitiseRrwebEvent`,
 * section 12.3), JSON-encoded, deflated above 1 KiB, fragmented to the SCTP message size and sent with per-chunk
 * backpressure (pause above 1 MiB, resume at 256 KiB, 3 s stall => drop and re-snapshot), or sliced and paced over
 * the WS relay. `seq` is per tab: 0 for a snapshot, 1, 2, 3 ... after it. Nacks within 2 s of a snapshot coalesce.
 */
import {
  LIMITS,
  MIRROR_FRAME_HEADER_BYTES,
  deflatePayload,
  encodeMirrorFrames,
  sanitiseRrwebEvent,
  utf8Encode,
  type MirrorTransport,
} from '@indiansassist/shared';
import { relayParts, type RelayPacer } from './relay-pacer';

type TabSend = { seq: number; lastSnapshotAt: number; awaitingSnapshot: boolean; bytes: number; batches: number; lastAckAt: number; sentSinceAck: boolean; relayTooLarge: boolean };

export type MirrorSenderDeps = {
  channel: () => RTCDataChannel | null;
  relayAllowed: () => boolean;
  relay: RelayPacer;
  maxMessageSize: () => number;
  toTab: (tabId: number, msg: { t: string } & Record<string, unknown>) => void;
  onTooLarge: (tabId: number, transport: MirrorTransport) => void;
  onTransport: (t: MirrorTransport) => void;
  deflate?: (raw: Uint8Array) => Promise<Uint8Array>;
  now?: () => number;
  stallMs?: number;
};

export class MirrorSender {
  readonly tabs = new Map<number, TabSend>();
  focused: number | null = null;
  transport: MirrorTransport = 'dc';
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly d: MirrorSenderDeps) {
    this.now = d.now ?? Date.now;
  }

  private tab(tabId: number): TabSend {
    let t = this.tabs.get(tabId);
    if (!t) {
      t = { seq: 0, lastSnapshotAt: 0, awaitingSnapshot: true, bytes: 0, batches: 0, lastAckAt: this.now(), sentSinceAck: false, relayTooLarge: false };
      this.tabs.set(tabId, t);
    }
    return t;
  }

  totals(): { bytes: number; batches: number; tabs: Record<string, { bytes: number; batches: number }> } {
    let bytes = 0;
    let batches = 0;
    const tabs: Record<string, { bytes: number; batches: number }> = {};
    for (const [id, t] of this.tabs) {
      bytes += t.bytes;
      batches += t.batches;
      tabs[String(id)] = { bytes: t.bytes, batches: t.batches };
    }
    return { bytes, batches, tabs };
  }

  /** `cs.events` from a content script; the content script sends only for the focused tab. */
  ingest(tabId: number, events: unknown[], snapshot: boolean): Promise<void> {
    const run = this.chain.then(() => this.send(tabId, events, snapshot));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async send(tabId: number, events: unknown[], snapshot: boolean): Promise<void> {
    const t = this.tab(tabId);
    const clean = events.map((e) => sanitiseRrwebEvent(e)).filter((e) => e !== null && e !== undefined);
    if (clean.length === 0) return;
    if (!snapshot && t.awaitingSnapshot) return; // after a drop or stall only a snapshot re-syncs the Assist
    const raw = utf8Encode(JSON.stringify(clean));
    if (snapshot && raw.length > LIMITS.mirrorSnapshotMaxRawBytes) return this.tooLarge(tabId, 'dc');
    const seq = snapshot ? 0 : t.seq + 1;
    const deflate = raw.length > LIMITS.mirrorDeflateMinBytes;
    const payload = deflate ? await (this.d.deflate ?? deflatePayload)(raw) : raw;
    const ch = this.d.channel();
    if (ch && ch.readyState === 'open') {
      this.setTransport('dc');
      const chunkBytes = Math.min(this.d.maxMessageSize(), LIMITS.mirrorDcChunkBytes) - MIRROR_FRAME_HEADER_BYTES;
      const frames = encodeMirrorFrames({ kind: snapshot ? 'snapshot' : 'batch', tabId, seq, rawLength: raw.length, payload, deflate, chunkBytes });
      if (!(await this.sendFrames(ch, frames))) return this.stalled(tabId);
    } else if (this.d.relayAllowed()) {
      this.setTransport('relay');
      if (snapshot && payload.length > LIMITS.mirrorRelaySnapshotMaxBytes) {
        t.relayTooLarge = true;
        return this.tooLarge(tabId, 'relay');
      }
      const parts = relayParts(payload, { tabId, seq, kind: snapshot ? 'snapshot' : 'batch', enc: deflate ? 'deflate' : 'none' });
      if (!parts) return this.tooLarge(tabId, 'relay');
      if (snapshot) this.d.relay.drop(tabId);
      this.d.relay.enqueue(parts);
    } else {
      t.awaitingSnapshot = true; // nothing can carry it: re-snapshot when a transport opens
      return;
    }
    t.seq = seq;
    if (snapshot) {
      t.lastSnapshotAt = this.now();
      t.awaitingSnapshot = false;
    }
    t.bytes += payload.length;
    t.batches++;
    t.sentSinceAck = true;
  }

  /** Sends parts back to back; per chunk, waits while `bufferedAmount` > 1 MiB; false after a 3 s stall. */
  private async sendFrames(ch: RTCDataChannel, frames: ArrayBuffer[]): Promise<boolean> {
    ch.bufferedAmountLowThreshold = LIMITS.mirrorDcResumeBytes;
    for (const f of frames) {
      if (ch.bufferedAmount > LIMITS.mirrorDcPauseBytes && !(await this.drain(ch))) return false;
      if (ch.readyState !== 'open') return false;
      try {
        ch.send(f);
      } catch {
        return false;
      }
    }
    return true;
  }

  private drain(ch: RTCDataChannel): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        ch.removeEventListener('bufferedamountlow', low);
        resolve(ok);
      };
      const low = () => done(true);
      const timer = setTimeout(() => done(false), this.d.stallMs ?? LIMITS.mirrorDcStallMs);
      ch.addEventListener('bufferedamountlow', low);
    });
  }

  private stalled(tabId: number): void {
    // Stall recovery (section 4.5): drop the queued batches, re-snapshot once the channel drains. No audit entry.
    this.tab(tabId).awaitingSnapshot = true;
    const ch = this.d.channel();
    const again = () => this.snapshot(tabId);
    if (ch && ch.readyState === 'open') ch.addEventListener('bufferedamountlow', again, { once: true });
  }

  private tooLarge(tabId: number, transport: MirrorTransport): void {
    this.tab(tabId).awaitingSnapshot = true;
    this.d.toTab(tabId, { t: 'oc.stop', reason: 'too_large' });
    this.d.onTooLarge(tabId, transport);
  }

  snapshot(tabId: number): void {
    this.tab(tabId).awaitingSnapshot = true;
    this.d.toTab(tabId, { t: 'oc.snapshot' });
  }

  /** `mirror.nack`: one snapshot, coalesced with a snapshot sent in the last 2 s. */
  nack(tabId: number): void {
    const t = this.tabs.get(tabId);
    if (t && this.now() - t.lastSnapshotAt < LIMITS.mirrorNackIntervalMs) return;
    this.snapshot(tabId);
  }

  ack(tabId: number): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.lastAckAt = this.now();
    t.sentSinceAck = false;
  }

  /** Ack-based stall check (section 4.5): no `mirror.ack` for 10 s while frames were sent. */
  checkAcks(): void {
    if (this.focused === null) return;
    const t = this.tabs.get(this.focused);
    if (t && t.sentSinceAck && this.now() - t.lastAckAt > LIMITS.mirrorAckTimeoutMs) {
      t.lastAckAt = this.now();
      this.snapshot(this.focused);
    }
  }

  setFocus(tabId: number | null, ports: Iterable<number>): void {
    this.focused = tabId;
    for (const id of ports) this.d.toTab(id, { t: 'oc.focus', focused: id === tabId });
  }

  /**
   * `ia.mirror` opened. After relay this is a transport switch (announced by a snapshot); on the first open, which
   * may come after the relay grace (4.6) held frames back, every tab still waiting for a snapshot gets one.
   */
  channelOpened(): void {
    if (this.transport !== 'dc') return this.setTransport('dc');
    for (const [id, s] of this.tabs) if (s.awaitingSnapshot) this.snapshot(id);
  }

  /** A transport switch is announced by a fresh snapshot of the focused tab on the new transport (4.6). */
  setTransport(t: MirrorTransport): void {
    if (this.transport === t) return;
    this.transport = t;
    this.d.onTransport(t);
    if (t === 'dc') {
      // A tab that was too large only on relay is retried when the data channel re-opens (section 4.3).
      for (const [id, s] of this.tabs) {
        if (!s.relayTooLarge) continue;
        s.relayTooLarge = false;
        this.snapshot(id);
      }
    }
    if (this.focused !== null) this.snapshot(this.focused);
  }

  forget(tabId: number): void {
    this.tabs.delete(tabId);
    this.d.relay.drop(tabId);
  }
}
