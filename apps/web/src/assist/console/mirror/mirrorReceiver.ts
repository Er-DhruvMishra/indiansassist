/**
 * Assist-side mirror receiver (Phase B 4.3-4.6): reassembles binary parts from `ia.mirror` (shared
 * `MirrorReassembler`) and relay parts from `mirror.relay`, inflates, parses the rrweb event array, enforces the
 * per-tab `seq` rule (a gap drops the batch, sends one nack per tab per 2 s and ignores batches until the next
 * snapshot), and schedules acks (every 2 s while frames arrive, and right after a snapshot was applied).
 * Messages are decoded strictly in arrival order (one promise chain), so an inflate never reorders batches.
 */
import {
  LIMITS,
  MirrorReassembler,
  base64urlDecode,
  inflatePayload,
  isMirrorMessage,
  utf8Decode,
  type MirrorFrameKind,
} from '@indiansassist/shared';

export type MirrorAckMsg = { t: 'mirror.ack' | 'mirror.nack'; tabId: number; seq: number; ts: number };
export type RelayFrame = { tabId: number; seq: number; kind: 'batch' | 'snapshot' | 'json'; enc: 'none' | 'deflate'; part: number; parts: number; data: string };

export type ReceiverDeps = {
  onSnapshot: (tabId: number, events: unknown[]) => void;
  onEvents: (tabId: number, seq: number, events: unknown[]) => void;
  /** A `kind: 'json'` relay frame (a `mirror.tabs` / `mirror.tab` message through the server). */
  onJson?: (value: unknown) => void;
  send: (msg: MirrorAckMsg) => void;
  inflate?: (bytes: Uint8Array) => Promise<Uint8Array>;
  now?: () => number;
};

type TabSeq = { last: number; awaiting: boolean; lastNackAt: number; lastAckAt: number; unacked: boolean; snapshotAt: number | null };
type RelayPending = { kind: MirrorFrameKind; enc: 'none' | 'deflate'; parts: number; chunks: (Uint8Array | undefined)[]; got: number; bytes: number; firstAt: number };
type Whole = { kind: MirrorFrameKind; tabId: number; seq: number; deflate: boolean; payload: Uint8Array };

const WINDOW_MS = 10_000;

export class MirrorReceiver {
  private readonly reasm = new MirrorReassembler();
  private readonly relay = new Map<string, RelayPending>();
  private readonly tabs = new Map<number, TabSeq>();
  private chain: Promise<void> = Promise.resolve();
  private samples: { at: number; n: number }[] = [];
  private readonly now: () => number;
  /** Decode failures and gaps seen (diagnostics). */
  gaps = 0;

  constructor(private readonly deps: ReceiverDeps) {
    this.now = deps.now ?? Date.now;
  }

  private tab(tabId: number): TabSeq {
    let t = this.tabs.get(tabId);
    if (!t) {
      t = { last: 0, awaiting: true, lastNackAt: -Infinity, lastAckAt: -Infinity, unacked: false, snapshotAt: null };
      this.tabs.set(tabId, t);
    }
    return t;
  }

  private count(n: number): void {
    const at = this.now();
    this.samples.push({ at, n });
    while (this.samples.length > 0 && at - this.samples[0]!.at > WINDOW_MS) this.samples.shift();
  }

  /** Mirror bitrate over the last 10 s (kbps), data channel and relay together. */
  kbps(): number {
    const at = this.now();
    const bytes = this.samples.filter((s) => at - s.at <= WINDOW_MS).reduce((a, s) => a + s.n, 0);
    return Math.round(((bytes * 8) / (WINDOW_MS / 1000) / 1000) * 10) / 10;
  }

  snapshotAge(tabId: number): number | null {
    const t = this.tabs.get(tabId)?.snapshotAt;
    return t === null || t === undefined ? null : this.now() - t;
  }

  private nack(tabId: number, seq: number): void {
    this.gaps += 1;
    if (tabId < 0) return;
    const t = this.tab(tabId);
    t.awaiting = true;
    const at = this.now();
    if (at - t.lastNackAt < LIMITS.mirrorNackIntervalMs) return;
    t.lastNackAt = at;
    this.deps.send({ t: 'mirror.nack', tabId, seq: Math.max(0, seq), ts: at });
  }

  /** One binary part from `ia.mirror`. */
  pushBinary(frame: ArrayBuffer): void {
    this.count(frame.byteLength);
    const r = this.reasm.push(frame, this.now());
    if (r === null) return;
    if (!isMirrorMessage(r)) return this.nack(r.tabId, r.seq);
    this.enqueue({ kind: r.kind, tabId: r.tabId, seq: r.seq, deflate: r.deflate, payload: r.payload });
  }

  /** One `mirror.relay` frame from the server (Phase B 4.6). */
  pushRelay(m: RelayFrame): void {
    this.count(m.data.length);
    let bytes: Uint8Array;
    try {
      bytes = base64urlDecode(m.data);
    } catch {
      return this.nack(m.kind === 'json' ? -1 : m.tabId, m.seq);
    }
    if (m.kind === 'json') {
      try {
        this.deps.onJson?.(JSON.parse(utf8Decode(bytes)));
      } catch {
        this.gaps += 1;
      }
      return;
    }
    // A snapshot supersedes the tab's unfinished batches: the Desk drops their unsent parts (relay pacer), so they
    // would only expire later, nack and freeze the view although the snapshot was applied. Batch seqs restart after
    // a snapshot, so a stale partial could also collide with a new batch of the same seq.
    if (m.kind === 'snapshot') this.dropRelayBatches(m.tabId);
    const key = `${m.tabId}:${m.kind}:${m.seq}`;
    let p = this.relay.get(key);
    if (p && m.part === 1 && p.chunks[0] !== undefined) {
      // Part 1 again: a new message under the same key (superseded snapshot); start over instead of mixing parts.
      this.relay.delete(key);
      p = undefined;
    }
    if (!p) {
      p = { kind: m.kind, enc: m.enc, parts: m.parts, chunks: new Array<Uint8Array | undefined>(m.parts), got: 0, bytes: 0, firstAt: this.now() };
      this.relay.set(key, p);
    } else if (p.parts !== m.parts || p.enc !== m.enc) {
      this.relay.delete(key);
      return this.nack(m.tabId, m.seq);
    }
    if (p.chunks[m.part - 1] === undefined) {
      p.chunks[m.part - 1] = bytes;
      p.got += 1;
      p.bytes += bytes.length;
    }
    if (p.bytes > LIMITS.mirrorSnapshotMaxRawBytes) {
      this.relay.delete(key);
      return this.nack(m.tabId, m.seq);
    }
    if (p.got < p.parts) return;
    this.relay.delete(key);
    const payload = new Uint8Array(p.bytes);
    let off = 0;
    for (const c of p.chunks) {
      payload.set(c!, off);
      off += c!.length;
    }
    this.enqueue({ kind: p.kind, tabId: m.tabId, seq: m.seq, deflate: p.enc === 'deflate', payload });
  }

  private dropRelayBatches(tabId: number): void {
    const prefix = `${tabId}:batch:`;
    for (const key of [...this.relay.keys()]) if (key.startsWith(prefix)) this.relay.delete(key);
  }

  private enqueue(w: Whole): void {
    this.chain = this.chain.then(() => this.decode(w)).catch(() => this.nack(w.tabId, w.seq));
  }

  /** Resolves when every message received so far has been decoded and delivered (tests, teardown). */
  drain(): Promise<void> {
    return this.chain;
  }

  private async decode(w: Whole): Promise<void> {
    const raw = w.deflate ? await (this.deps.inflate ?? ((b) => inflatePayload(b)))(w.payload) : w.payload;
    const events: unknown = JSON.parse(utf8Decode(raw));
    if (!Array.isArray(events)) throw new Error('mirror payload is not an array');
    const t = this.tab(w.tabId);
    if (w.kind === 'snapshot') {
      this.reasm.dropTab(w.tabId);
      t.last = w.seq;
      t.awaiting = false;
      t.snapshotAt = this.now();
      t.unacked = true;
      this.deps.onSnapshot(w.tabId, events);
      return;
    }
    if (t.awaiting) {
      // After a nack every batch is ignored until the next snapshot (section 4.3); a tab never seen asks once.
      this.nack(w.tabId, w.seq);
      return;
    }
    if (w.seq !== t.last + 1) return this.nack(w.tabId, w.seq);
    t.last = w.seq;
    t.unacked = true;
    this.deps.onEvents(w.tabId, w.seq, events);
  }

  /** The replayer applied a snapshot: ack at once (section 4.5). */
  applied(tabId: number): void {
    const t = this.tabs.get(tabId);
    if (!t || t.awaiting) return;
    t.lastAckAt = this.now();
    t.unacked = false;
    this.deps.send({ t: 'mirror.ack', tabId, seq: t.last, ts: t.lastAckAt });
  }

  /** Call about once a second: expires incomplete messages (nack) and sends the periodic acks. */
  tick(): void {
    const at = this.now();
    for (const g of this.reasm.expire(at)) this.nack(g.tabId, g.seq);
    for (const [key, p] of this.relay) {
      if (at - p.firstAt < LIMITS.mirrorReassembleTimeoutMs) continue;
      this.relay.delete(key);
      const [tabId, , seq] = key.split(':');
      this.nack(Number(tabId), Number(seq));
    }
    for (const [tabId, t] of this.tabs) {
      if (!t.unacked || t.awaiting || at - t.lastAckAt < LIMITS.mirrorAckIntervalMs) continue;
      t.lastAckAt = at;
      t.unacked = false;
      this.deps.send({ t: 'mirror.ack', tabId, seq: t.last, ts: at });
    }
  }

  /** Forget a tab (closed, detached): the next frame for it must start with a snapshot. */
  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
    this.reasm.dropTab(tabId);
    for (const key of [...this.relay.keys()]) if (key.startsWith(`${tabId}:`)) this.relay.delete(key);
  }

  /** After a link rebuild every tab waits for its fresh snapshot (Phase B 3.5). */
  expectSnapshots(): void {
    for (const t of this.tabs.values()) t.awaiting = true;
  }
}
