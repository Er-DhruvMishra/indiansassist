/**
 * File transfer primitives (Phase A section 8.3), ported from `apps/web/src/lib/fileChunker.ts` with identical
 * algorithms (section 7: the web `lib/` is not imported): chunk framing, offer validation (F2, F5), the receiver's
 * reassembly rules (F4), sha256 and type sniffing (F6).
 */
import { LIMITS, encodeFileChunk, sanitiseFileName, sha256Hex, type DcFileOffer, type FileChunk } from '@indiansassist/shared';

export const CHUNK_SIZE = LIMITS.fileChunkSize;

/** Reads a Blob in windows of 64 chunks so a big file never sits in memory twice. */
export async function* chunkBlob(blob: Blob, fileId: number, chunkSize: number = CHUNK_SIZE): AsyncGenerator<Uint8Array> {
  const windowBytes = chunkSize * 64;
  let index = 0;
  for (let off = 0; off < blob.size; off += windowBytes) {
    const buf = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + windowBytes)).arrayBuffer());
    for (let p = 0; p < buf.length; p += chunkSize) {
      yield encodeFileChunk(fileId, index++, buf.subarray(p, Math.min(buf.length, p + chunkSize)));
    }
  }
}

export async function sha256HexOf(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
      return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through */
    }
  }
  return sha256Hex(data);
}

export function makeOffer(fileId: number, name: string, size: number, mime: string, sha256: string, now = Date.now()): DcFileOffer {
  return {
    t: 'file.offer',
    fileId,
    name: sanitiseFileName(name, fileId),
    size,
    mime: mime || 'application/octet-stream',
    sha256,
    chunkSize: CHUNK_SIZE,
    chunks: Math.ceil(size / CHUNK_SIZE),
    ts: now,
  };
}

export type OfferCheck = { ok: true; name: string } | { ok: false; reason: 'too_large' | 'bad_name' };

export function checkOffer(offer: Pick<DcFileOffer, 'fileId' | 'name' | 'size'>): OfferCheck {
  if (offer.name.length === 0 || offer.name.length > LIMITS.fileOfferNameMax) return { ok: false, reason: 'bad_name' };
  if (offer.size > LIMITS.fileMaxBytes) return { ok: false, reason: 'too_large' };
  return { ok: true, name: sanitiseFileName(offer.name, offer.fileId) };
}

/** Reassembles one accepted transfer, enforcing every F4 receiver rule. */
export class FileAssembler {
  private parts: (Uint8Array | undefined)[];
  private count = 0;
  received = 0;

  constructor(
    readonly fileId: number,
    readonly size: number,
    readonly chunks: number,
    readonly chunkSize: number = CHUNK_SIZE,
  ) {
    this.parts = new Array<Uint8Array | undefined>(chunks);
  }

  ingest(chunk: FileChunk): 'bad_chunk' | 'overflow' | null {
    if (chunk.fileId !== this.fileId || chunk.chunkIndex >= this.chunks) return 'bad_chunk';
    if (this.parts[chunk.chunkIndex] !== undefined) return 'bad_chunk';
    const isLast = chunk.chunkIndex === this.chunks - 1;
    if (!isLast && chunk.payload.length !== this.chunkSize) return 'bad_chunk';
    if (this.received + chunk.payload.length > this.size) return 'overflow';
    this.parts[chunk.chunkIndex] = chunk.payload.slice();
    this.received += chunk.payload.length;
    this.count++;
    return null;
  }

  finish(): { ok: true; bytes: Uint8Array } | { ok: false; reason: 'bad_chunk' } {
    if (this.count !== this.chunks || this.received !== this.size) return { ok: false, reason: 'bad_chunk' };
    const out = new Uint8Array(this.size);
    let off = 0;
    for (const p of this.parts) {
      out.set(p!, off);
      off += p!.length;
    }
    return { ok: true, bytes: out };
  }

  free(): void {
    this.parts = [];
  }
}

const SIGNATURES: [number[], string, number?][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'PNG image'],
  [[0xff, 0xd8, 0xff], 'JPEG image'],
  [[0x47, 0x49, 0x46, 0x38], 'GIF image'],
  [[0x25, 0x50, 0x44, 0x46], 'PDF document'],
  [[0x50, 0x4b, 0x03, 0x04], 'ZIP archive (also docx / xlsx / jar / apk)'],
  [[0x4d, 0x5a], 'Windows executable (PE)'],
  [[0x7f, 0x45, 0x4c, 0x46], 'ELF executable'],
  [[0x1f, 0x8b], 'gzip archive'],
  [[0x52, 0x61, 0x72, 0x21], 'RAR archive'],
  [[0x37, 0x7a, 0xbc, 0xaf], '7-Zip archive'],
  [[0x1a, 0x45, 0xdf, 0xa3], 'WebM / Matroska video'],
  [[0x66, 0x74, 0x79, 0x70], 'MP4 / QuickTime media', 4],
  [[0x23, 0x21], 'script (shebang)'],
];

/** Best-effort content sniffing of the first bytes (shown on the save prompt, F6). */
export function sniffType(b: Uint8Array): string {
  for (const [sig, name, off = 0] of SIGNATURES) if (sig.every((v, i) => b[off + i] === v)) return name;
  const sample = b.subarray(0, Math.min(b.length, 512));
  if (sample.length === 0) return 'empty';
  let printable = 0;
  for (const c of sample) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  return printable / sample.length > 0.95 ? 'text' : 'binary data';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
