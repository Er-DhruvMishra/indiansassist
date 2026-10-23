/**
 * File transfer primitives (contracts section 8.3), pure and unit tested: the sender's chunker, the
 * receiver's reassembly rules (F4), offer validation (F2, F5), sha256 and type sniffing (F6).
 */
import {
  LIMITS,
  encodeFileChunk,
  sanitiseFileName,
  sha256Hex as nobleSha256Hex,
  type DcFileOffer,
  type FileChunk,
} from '@indiansassist/shared';

export const CHUNK_SIZE = LIMITS.fileChunkSize;

/** Splits `bytes` into binary chunk frames: 8-byte header (fileId, chunkIndex, both uint32 BE) + payload. */
export function* chunkBytes(bytes: Uint8Array, fileId: number, chunkSize: number = CHUNK_SIZE): Generator<Uint8Array> {
  const chunks = Math.ceil(bytes.length / chunkSize);
  for (let i = 0; i < chunks; i++) {
    yield encodeFileChunk(fileId, i, bytes.subarray(i * chunkSize, Math.min(bytes.length, (i + 1) * chunkSize)));
  }
}

/** Same as `chunkBytes` for a Blob, reading 64 chunks (1 MiB) at a time so big files never sit in memory twice. */
export async function* chunkBlob(blob: Blob, fileId: number, chunkSize: number = CHUNK_SIZE): AsyncGenerator<Uint8Array> {
  const window = chunkSize * 64;
  let index = 0;
  for (let off = 0; off < blob.size; off += window) {
    const buf = new Uint8Array(await blob.slice(off, Math.min(blob.size, off + window)).arrayBuffer());
    for (let p = 0; p < buf.length; p += chunkSize) {
      yield encodeFileChunk(fileId, index++, buf.subarray(p, Math.min(buf.length, p + chunkSize)));
    }
  }
}

export async function sha256HexOf(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const d = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
      return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through to the pure implementation */
    }
  }
  return nobleSha256Hex(bytes);
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

/** Receiver-side offer validation: F5 (empty or > 255 name => bad_name, re-sanitise) and F2 (256 MiB cap). */
export function checkOffer(offer: Pick<DcFileOffer, 'fileId' | 'name' | 'size'>): OfferCheck {
  if (offer.name.length === 0 || offer.name.length > LIMITS.fileOfferNameMax) return { ok: false, reason: 'bad_name' };
  if (offer.size > LIMITS.fileMaxBytes) return { ok: false, reason: 'too_large' };
  return { ok: true, name: sanitiseFileName(offer.name, offer.fileId) };
}

export type CancelReason = 'bad_chunk' | 'overflow';

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

  /** Returns null when the chunk was stored, else the `file.cancel` reason. */
  ingest(chunk: FileChunk): CancelReason | null {
    if (chunk.fileId !== this.fileId) return 'bad_chunk';
    if (chunk.chunkIndex >= this.chunks) return 'bad_chunk';
    if (this.parts[chunk.chunkIndex] !== undefined) return 'bad_chunk';
    const isLast = chunk.chunkIndex === this.chunks - 1;
    if (!isLast && chunk.payload.length !== this.chunkSize) return 'bad_chunk';
    if (this.received + chunk.payload.length > this.size) return 'overflow';
    this.parts[chunk.chunkIndex] = chunk.payload.slice();
    this.received += chunk.payload.length;
    this.count++;
    return null;
  }

  /** After `file.done`: every chunk present and total bytes === size. */
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

/** Best-effort content sniffing of the first bytes (shown on the save prompt, F6). */
export function sniffType(bytes: Uint8Array): string {
  const b = bytes;
  const starts = (sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'PNG image';
  if (starts([0xff, 0xd8, 0xff])) return 'JPEG image';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'GIF image';
  if (starts([0x25, 0x50, 0x44, 0x46])) return 'PDF document';
  if (starts([0x50, 0x4b, 0x03, 0x04])) return 'ZIP archive (also docx / xlsx / jar / apk)';
  if (starts([0x4d, 0x5a])) return 'Windows executable (PE)';
  if (starts([0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable';
  if (starts([0x1f, 0x8b])) return 'gzip archive';
  if (starts([0x52, 0x61, 0x72, 0x21])) return 'RAR archive';
  if (starts([0x37, 0x7a, 0xbc, 0xaf])) return '7-Zip archive';
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return 'WebM / Matroska video';
  if (starts([0x66, 0x74, 0x79, 0x70], 4)) return 'MP4 / QuickTime media';
  if (starts([0x23, 0x21])) return 'script (shebang)';
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
