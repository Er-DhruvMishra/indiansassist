/**
 * The capture batcher (section 4.3): flush at 64 events or 200 ms after the first queued event; a FullSnapshot
 * (type 2) always flushes alone with its preceding Meta (type 4) as a `snapshot` frame; raw batches split at
 * 256 KiB of JSON; a MouseMove is dropped when another one is queued behind it. Unfocused tabs buffer locally
 * (2 MiB raw cap); on overflow the buffer is dropped and a fresh snapshot is needed on the next focus.
 */
import { LIMITS } from '@indiansassist/shared';

export type Batch = { events: unknown[]; snapshot: boolean };

export type BatcherOptions = {
  maxEvents?: number;
  maxMs?: number;
  maxBytes?: number;
  bufferBytes?: number;
};

type Sized = { e: unknown; size: number };

const META = 4;
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const MOUSE_MOVE_SOURCE = 1;

function isMouseMove(e: unknown): boolean {
  const ev = e as { type?: number; data?: { source?: number } };
  return ev?.type === INCREMENTAL && ev.data?.source === MOUSE_MOVE_SOURCE;
}

export class Batcher {
  focused = false;
  private queue: Sized[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingMeta: unknown = null;
  private deferredSnapshot: Batch | null = null;
  private buffer: Sized[] = [];
  private bufferedBytes = 0;
  private overflowed = false;
  private readonly maxEvents: number;
  private readonly maxMs: number;
  private readonly maxBytes: number;
  private readonly bufferCap: number;

  constructor(
    private readonly out: (b: Batch) => void,
    private readonly needSnapshot: () => void,
    o: BatcherOptions = {},
  ) {
    this.maxEvents = o.maxEvents ?? LIMITS.mirrorBatchMaxEvents;
    this.maxMs = o.maxMs ?? LIMITS.mirrorBatchMaxMs;
    this.maxBytes = o.maxBytes ?? LIMITS.mirrorBatchMaxRawBytes;
    this.bufferCap = o.bufferBytes ?? LIMITS.mirrorBackgroundBufferBytes;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  push(e: unknown): void {
    const type = (e as { type?: number })?.type;
    if (type === META) {
      this.pendingMeta = e;
      return;
    }
    if (type === FULL_SNAPSHOT) {
      const events = this.pendingMeta ? [this.pendingMeta, e] : [e];
      this.pendingMeta = null;
      const snap: Batch = { events, snapshot: true };
      if (!this.focused) {
        // A snapshot for an unfocused tab is deferred until focus and supersedes the buffer.
        this.deferredSnapshot = snap;
        this.buffer = [];
        this.bufferedBytes = 0;
        this.overflowed = false;
        return;
      }
      this.flush();
      this.out(snap);
      return;
    }
    const size = JSON.stringify(e)?.length ?? 0;
    if (!this.focused) return this.bufferEvent({ e, size });
    if (isMouseMove(e)) {
      const prev = this.queue.findIndex((q) => isMouseMove(q.e));
      if (prev >= 0) {
        this.queuedBytes -= this.queue[prev]!.size;
        this.queue.splice(prev, 1);
      }
    }
    this.queue.push({ e, size });
    this.queuedBytes += size;
    if (this.queue.length >= this.maxEvents) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.maxMs);
  }

  private bufferEvent(s: Sized): void {
    if (this.overflowed) return;
    this.buffer.push(s);
    this.bufferedBytes += s.size;
    if (this.bufferedBytes > this.bufferCap) {
      this.buffer = [];
      this.bufferedBytes = 0;
      this.overflowed = true;
    }
  }

  /** Emits the queue as one or more batches of at most 256 KiB raw JSON each. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) return;
    let cur: unknown[] = [];
    let bytes = 2;
    for (const q of this.queue) {
      if (cur.length > 0 && bytes + q.size + 1 > this.maxBytes) {
        this.out({ events: cur, snapshot: false });
        cur = [];
        bytes = 2;
      }
      cur.push(q.e);
      bytes += q.size + 1;
    }
    if (cur.length > 0) this.out({ events: cur, snapshot: false });
    this.queue = [];
    this.queuedBytes = 0;
  }

  /** Focus changes (`oc.focus`): on focus the deferred snapshot and the buffer go out (or a snapshot is asked). */
  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    if (!focused) {
      this.flush();
      return;
    }
    if (this.overflowed) {
      this.overflowed = false;
      this.buffer = [];
      this.bufferedBytes = 0;
      this.needSnapshot();
      return;
    }
    if (this.deferredSnapshot) {
      this.out(this.deferredSnapshot);
      this.deferredSnapshot = null;
    }
    const buffered = this.buffer;
    this.buffer = [];
    this.bufferedBytes = 0;
    for (const b of buffered) {
      this.queue.push(b);
      this.queuedBytes += b.size;
    }
    this.flush();
  }

  /** Drops everything (pause, stop, a stall: the next snapshot re-syncs). */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.pendingMeta = null;
    this.deferredSnapshot = null;
    this.overflowed = false;
  }
}
