/**
 * Binary frames on `ia.mirror` (docs/specs/phase-b-contracts.md section 4.5): a 20-byte header plus one chunk of the
 * (optionally deflated) UTF-8 JSON array of rrweb events. Every message is fragmented to the SCTP message size; the
 * receiver reassembles by `(tabId, kind, seq)` in any order and discards a message whose parts did not all arrive
 * within `LIMITS.mirrorReassembleTimeoutMs`.
 *
 * | bytes  | field                                          |
 * | [0]    | version 2                                      |
 * | [1]    | kind: 1 batch, 2 snapshot                      |
 * | [2]    | flags: bit 0 deflate                           |
 * | [3]    | reserved 0                                     |
 * | [4,8)  | uint32 BE tabId                                |
 * | [8,12) | uint32 BE seq                                  |
 * | [12,14)| uint16 BE part (1-based)                       |
 * | [14,16)| uint16 BE parts (1..256)                       |
 * | [16,20)| uint32 BE raw payload length (after inflation) |
 * | [20,n) | chunk                                          |
 */
import { LIMITS } from '../enums.js';

export const MIRROR_FRAME_VERSION = 2;
export const MIRROR_FRAME_HEADER_BYTES = 20;

export type MirrorFrameKind = 'batch' | 'snapshot';
const KIND_CODE: Record<MirrorFrameKind, number> = { batch: 1, snapshot: 2 };

export type MirrorFrameHeader = {
  version: number;
  kind: MirrorFrameKind;
  deflate: boolean;
  tabId: number;
  seq: number;
  part: number;
  parts: number;
  rawLength: number;
};

export type EncodeMirrorFramesInput = {
  kind: MirrorFrameKind;
  tabId: number;
  seq: number;
  /** Length of the payload after inflation (the JSON byte length). */
  rawLength: number;
  /** The payload to send: deflated bytes when `deflate`, else the raw JSON bytes. */
  payload: Uint8Array;
  deflate: boolean;
  /** Payload bytes per part: `min(pc.sctp?.maxMessageSize ?? 65536, LIMITS.mirrorDcChunkBytes) - 20`. */
  chunkBytes?: number;
};

function uint32(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`${what} must be a uint32`);
  return n;
}

/** Splits a payload into the ordered list of binary parts (each one `dc.send`). Throws above 256 parts or 8 MiB. */
export function encodeMirrorFrames(input: EncodeMirrorFramesInput): ArrayBuffer[] {
  const chunk = input.chunkBytes ?? LIMITS.mirrorDcChunkBytes - MIRROR_FRAME_HEADER_BYTES;
  if (!Number.isInteger(chunk) || chunk < 1) throw new RangeError('chunkBytes must be a positive integer');
  uint32(input.tabId, 'tabId');
  uint32(input.seq, 'seq');
  uint32(input.rawLength, 'rawLength');
  if (input.rawLength > LIMITS.mirrorSnapshotMaxRawBytes) throw new RangeError('raw payload exceeds 8 MiB');
  const total = input.payload.length;
  const parts = Math.max(1, Math.ceil(total / chunk));
  if (parts > LIMITS.mirrorDcMaxParts) throw new RangeError(`payload needs ${parts} parts (max ${LIMITS.mirrorDcMaxParts})`);
  const out: ArrayBuffer[] = [];
  for (let i = 0; i < parts; i++) {
    const body = input.payload.subarray(i * chunk, Math.min(total, (i + 1) * chunk));
    const buf = new ArrayBuffer(MIRROR_FRAME_HEADER_BYTES + body.length);
    const view = new DataView(buf);
    view.setUint8(0, MIRROR_FRAME_VERSION);
    view.setUint8(1, KIND_CODE[input.kind]);
    view.setUint8(2, input.deflate ? 1 : 0);
    view.setUint8(3, 0);
    view.setUint32(4, input.tabId, false);
    view.setUint32(8, input.seq, false);
    view.setUint16(12, i + 1, false);
    view.setUint16(14, parts, false);
    view.setUint32(16, input.rawLength, false);
    new Uint8Array(buf, MIRROR_FRAME_HEADER_BYTES).set(body);
    out.push(buf);
  }
  return out;
}

export type DecodeMirrorFrameResult =
  | { ok: true; header: MirrorFrameHeader; chunk: Uint8Array }
  | { ok: false; reason: 'short' | 'version' | 'kind' | 'flags' | 'parts' | 'part' | 'too_large' };

/** Parses one binary part; never throws. */
export function decodeMirrorFrame(frame: ArrayBuffer | Uint8Array): DecodeMirrorFrameResult {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.length < MIRROR_FRAME_HEADER_BYTES) return { ok: false, reason: 'short' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MIRROR_FRAME_VERSION) return { ok: false, reason: 'version' };
  const k = view.getUint8(1);
  if (k !== 1 && k !== 2) return { ok: false, reason: 'kind' };
  const flags = view.getUint8(2);
  if ((flags & ~1) !== 0 || view.getUint8(3) !== 0) return { ok: false, reason: 'flags' };
  const part = view.getUint16(12, false);
  const parts = view.getUint16(14, false);
  if (parts < 1 || parts > LIMITS.mirrorDcMaxParts) return { ok: false, reason: 'parts' };
  if (part < 1 || part > parts) return { ok: false, reason: 'part' };
  const rawLength = view.getUint32(16, false);
  if (rawLength > LIMITS.mirrorSnapshotMaxRawBytes) return { ok: false, reason: 'too_large' };
  return {
    ok: true,
    header: {
      version: MIRROR_FRAME_VERSION,
      kind: k === 1 ? 'batch' : 'snapshot',
      deflate: (flags & 1) === 1,
      tabId: view.getUint32(4, false),
      seq: view.getUint32(8, false),
      part,
      parts,
      rawLength,
    },
    chunk: bytes.subarray(MIRROR_FRAME_HEADER_BYTES),
  };
}

export type MirrorMessage = { kind: MirrorFrameKind; tabId: number; seq: number; deflate: boolean; rawLength: number; payload: Uint8Array };
export type MirrorGap = { tabId: number; kind: MirrorFrameKind; seq: number; reason: 'timeout' | 'mismatch' | 'decode' };

type Pending = { header: MirrorFrameHeader; chunks: (Uint8Array | undefined)[]; received: number; bytes: number; firstAt: number };

/**
 * Collects parts into whole messages. `push` returns the completed message, `null` while parts are missing, or a
 * gap when the part is undecodable or disagrees with earlier parts of the same message. `expire(now)` drops
 * messages older than the reassembly timeout and returns them as gaps (the caller nacks, section 4.3).
 */
export class MirrorReassembler {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly timeoutMs: number = LIMITS.mirrorReassembleTimeoutMs,
    private readonly maxBytes: number = LIMITS.mirrorSnapshotMaxRawBytes,
  ) {}

  push(frame: ArrayBuffer | Uint8Array, now: number = Date.now()): MirrorMessage | MirrorGap | null {
    const d = decodeMirrorFrame(frame);
    if (!d.ok) return { tabId: -1, kind: 'batch', seq: -1, reason: 'decode' };
    const h = d.header;
    if (h.parts === 1) return { kind: h.kind, tabId: h.tabId, seq: h.seq, deflate: h.deflate, rawLength: h.rawLength, payload: d.chunk.slice() };
    const key = `${h.tabId}:${h.kind}:${h.seq}`;
    let p = this.pending.get(key);
    if (!p) {
      p = { header: h, chunks: new Array<Uint8Array | undefined>(h.parts), received: 0, bytes: 0, firstAt: now };
      this.pending.set(key, p);
    } else if (p.header.parts !== h.parts || p.header.rawLength !== h.rawLength || p.header.deflate !== h.deflate) {
      this.pending.delete(key);
      return { tabId: h.tabId, kind: h.kind, seq: h.seq, reason: 'mismatch' };
    }
    if (p.chunks[h.part - 1] === undefined) {
      p.chunks[h.part - 1] = d.chunk.slice();
      p.received += 1;
      p.bytes += d.chunk.length;
      if (p.bytes > this.maxBytes) {
        this.pending.delete(key);
        return { tabId: h.tabId, kind: h.kind, seq: h.seq, reason: 'mismatch' };
      }
    }
    if (p.received < h.parts) return null;
    this.pending.delete(key);
    const payload = new Uint8Array(p.bytes);
    let off = 0;
    for (const c of p.chunks) {
      payload.set(c!, off);
      off += c!.length;
    }
    return { kind: h.kind, tabId: h.tabId, seq: h.seq, deflate: h.deflate, rawLength: h.rawLength, payload };
  }

  expire(now: number = Date.now()): MirrorGap[] {
    const out: MirrorGap[] = [];
    for (const [key, p] of this.pending) {
      if (now - p.firstAt < this.timeoutMs) continue;
      this.pending.delete(key);
      out.push({ tabId: p.header.tabId, kind: p.header.kind, seq: p.header.seq, reason: 'timeout' });
    }
    return out;
  }

  /** Drops every pending message of a tab (a snapshot replaces them). */
  dropTab(tabId: number): void {
    for (const [key, p] of this.pending) if (p.header.tabId === tabId) this.pending.delete(key);
  }

  get size(): number {
    return this.pending.size;
  }
}

/** True when a reassembler result is a whole message. */
export function isMirrorMessage(x: MirrorMessage | MirrorGap | null): x is MirrorMessage {
  return x !== null && 'payload' in x;
}

async function pump(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError(`inflated payload exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** zlib `deflate` (CompressionStream), as the offscreen document applies it before fragmentation. */
export async function deflatePayload(raw: Uint8Array): Promise<Uint8Array> {
  return pump(streamOf(raw).pipeThrough(new CompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>), Number.MAX_SAFE_INTEGER);
}

/** Inflates a payload, refusing (RangeError) to produce more than `maxBytes` (8 MiB by default). */
export async function inflatePayload(deflated: Uint8Array, maxBytes: number = LIMITS.mirrorSnapshotMaxRawBytes): Promise<Uint8Array> {
  return pump(streamOf(deflated).pipeThrough(new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>), maxBytes);
}
