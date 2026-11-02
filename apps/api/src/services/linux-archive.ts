/**
 * The per-download Linux archive (docs/specs/phase-e-contracts.md section 7.6): a `.tar.gz` holding one file, the
 * agent ELF, named `IndiansAssist-<region>-<dddd>-<dddd>-<dddd>` with mode 0755. It is two gzip members (RFC 1952
 * section 2.2 allows concatenation; GNU tar and bsdtar read them as one stream):
 *
 * - member 1: the 512-byte ustar header for the per-download name, built and compressed per request;
 * - member 2: the ELF padded to 512 bytes plus the two zero end-of-archive blocks, compressed once when the build is
 *   loaded (at boot and on the C section 2.2 reload) and cached.
 *
 * Everything is deterministic (tar mtime 0, uid / gid 0, user and group `root`; gzip header mtime 0, XFL 0, OS 255,
 * deflate level 6), so the bytes are a pure function of the grant and `Range` / `HEAD` work as for the Windows build.
 * Only `node:zlib`: the gzip header and trailer are written here around `deflateRawSync`.
 */
import * as zlib from 'node:zlib';
import { agentLinuxFileName, type Region } from '@indiansassist/shared';

export const LINUX_ARCHIVE_CONTENT_TYPE = 'application/gzip';
const BLOCK = 512;
const DEFLATE_LEVEL = 6;

/** The cached second member of a build: the compressed ELF body and the ELF's size (for the tar header). */
export type LinuxArchiveBody = { member: Buffer; elfSize: number };

/** The served archive name: `IndiansAssist-in-mum-4821-9365-7715.tar.gz`. */
export function linuxArchiveName(region: Region, deskCode: string): string {
  return `${agentLinuxFileName(region, deskCode)}.tar.gz`;
}

// ---------- CRC-32 (zlib.crc32 where this Node has it, else a table) ----------

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

export function crc32(data: Uint8Array): number {
  const native = (zlib as { crc32?: (d: Uint8Array) => number }).crc32;
  if (typeof native === 'function') return native(data) >>> 0;
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- gzip member ----------

/** One deterministic gzip member: `1f 8b 08`, no flags, mtime 0, XFL 0, OS 255; raw deflate at level 6; CRC-32, ISIZE. */
export function gzipMember(data: Uint8Array): Buffer {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
  const body = zlib.deflateRawSync(data, { level: DEFLATE_LEVEL });
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length % 0x1_0000_0000, 4);
  return Buffer.concat([header, body, trailer]);
}

// ---------- ustar ----------

function octal(buf: Buffer, offset: number, width: number, value: number): void {
  // `width - 1` zero-padded octal digits and a NUL terminator (the POSIX ustar numeric field form).
  const s = value.toString(8).padStart(width - 1, '0');
  if (s.length > width - 1) throw new Error('value too large for the ustar field');
  buf.write(s, offset, width - 1, 'ascii');
  buf[offset + width - 1] = 0;
}

/** The 512-byte ustar header of one regular file (mode 0755, uid / gid 0, `root` / `root`, mtime 0). */
export function ustarHeader(name: string, size: number): Buffer {
  if (!/^[\x21-\x7e]{1,100}$/.test(name)) throw new Error('tar member name must be 1-100 printable ASCII characters');
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('bad tar member size');
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'ascii');
  octal(h, 100, 8, 0o755); // mode
  octal(h, 108, 8, 0); // uid
  octal(h, 116, 8, 0); // gid
  octal(h, 124, 12, size); // size
  octal(h, 136, 12, 0); // mtime
  h.fill(0x20, 148, 156); // chksum: spaces while summing
  h[156] = 0x30; // typeflag '0': regular file
  h.write('ustar\0', 257, 6, 'ascii'); // magic
  h.write('00', 263, 2, 'ascii'); // version
  h.write('root', 265, 32, 'ascii'); // uname
  h.write('root', 297, 32, 'ascii'); // gname
  octal(h, 329, 8, 0); // devmajor
  octal(h, 337, 8, 0); // devminor
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i]!;
  // chksum: six octal digits, NUL, space (the form GNU tar writes).
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

// ---------- the two members ----------

/** Member 2, built once per loaded build: the ELF padded to a 512 multiple, then two zero blocks, compressed. */
export function linuxArchiveBody(elf: Uint8Array): LinuxArchiveBody {
  const padded = Math.ceil(elf.length / BLOCK) * BLOCK;
  const raw = Buffer.alloc(padded + 2 * BLOCK, 0);
  raw.set(elf, 0);
  return { member: gzipMember(raw), elfSize: elf.length };
}

/** Member 1, per request: the ustar header for the per-download inner name. */
export function linuxArchiveHead(innerName: string, elfSize: number): Buffer {
  return gzipMember(ustarHeader(innerName, elfSize));
}

/** The archive of one grant as its two members (concatenated on the wire). */
export function linuxArchiveParts(region: Region, deskCode: string, body: LinuxArchiveBody): Buffer[] {
  return [linuxArchiveHead(agentLinuxFileName(region, deskCode), body.elfSize), body.member];
}

export function partsLength(parts: readonly Buffer[]): number {
  return parts.reduce((n, p) => n + p.length, 0);
}

/** The views (no copies) of `parts` covering the inclusive byte range `start..end`. */
export function sliceParts(parts: readonly Buffer[], start: number, end: number): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  for (const p of parts) {
    const from = Math.max(start, at);
    const to = Math.min(end + 1, at + p.length);
    if (from < to) out.push(p.subarray(from - at, to - at));
    at += p.length;
  }
  return out;
}
