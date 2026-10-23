import { describe, expect, it } from 'vitest';
import { decodeFileChunk, dcFileOfferSchema, sha256Hex } from '@indiansassist/shared';
import {
  CHUNK_SIZE,
  FileAssembler,
  checkOffer,
  chunkBlob,
  chunkBytes,
  formatBytes,
  makeOffer,
  sha256HexOf,
  sniffType,
} from '../src/lib/fileChunker';

function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

describe('chunkBytes', () => {
  it('splits into ceil(size / 16384) frames with an 8-byte big-endian header', () => {
    const data = bytes(CHUNK_SIZE * 2 + 100);
    const frames = [...chunkBytes(data, 7)];
    expect(frames).toHaveLength(3);
    expect(frames[0]!.length).toBe(8 + CHUNK_SIZE);
    expect(frames[2]!.length).toBe(8 + 100);
    const view = new DataView(frames[1]!.buffer, frames[1]!.byteOffset);
    expect(view.getUint32(0, false)).toBe(7);
    expect(view.getUint32(4, false)).toBe(1);
    const decoded = decodeFileChunk(frames[2]!)!;
    expect(decoded).toMatchObject({ fileId: 7, chunkIndex: 2 });
    expect([...decoded.payload]).toEqual([...data.subarray(CHUNK_SIZE * 2)]);
  });

  it('produces no frames for an empty file and one short frame for a tiny file', () => {
    expect([...chunkBytes(new Uint8Array(0), 1)]).toHaveLength(0);
    expect([...chunkBytes(bytes(5), 1)][0]!.length).toBe(13);
  });

  it('chunkBlob yields exactly the same frames as chunkBytes across its 1 MiB read window', async () => {
    const data = bytes(CHUNK_SIZE * 65 + 3);
    const fromBlob: Uint8Array[] = [];
    for await (const f of chunkBlob(new Blob([data as Uint8Array<ArrayBuffer>]), 9)) fromBlob.push(f);
    const fromBytes = [...chunkBytes(data, 9)];
    expect(fromBlob).toHaveLength(fromBytes.length);
    expect(fromBlob.every((f, i) => f.length === fromBytes[i]!.length && f.every((v, j) => v === fromBytes[i]![j]))).toBe(true);
  });
});

describe('FileAssembler (receiver rules F4)', () => {
  const size = CHUNK_SIZE * 2 + 10;
  const data = bytes(size);
  const frames = () => [...chunkBytes(data, 3)].map((f) => decodeFileChunk(f)!);

  it('reassembles chunks received out of order', () => {
    const asm = new FileAssembler(3, size, 3);
    const [a, b, c] = frames();
    expect(asm.ingest(c!)).toBeNull();
    expect(asm.ingest(a!)).toBeNull();
    expect(asm.ingest(b!)).toBeNull();
    const done = asm.finish();
    expect(done.ok).toBe(true);
    if (done.ok) expect([...done.bytes]).toEqual([...data]);
  });

  it('rejects an index past the end, a duplicate, a short non-final chunk and the wrong file id', () => {
    const asm = new FileAssembler(3, size, 3);
    const [a, b] = frames();
    expect(asm.ingest({ ...a!, chunkIndex: 3 })).toBe('bad_chunk');
    expect(asm.ingest(a!)).toBeNull();
    expect(asm.ingest(a!)).toBe('bad_chunk');
    expect(asm.ingest({ ...b!, payload: b!.payload.subarray(0, 100) })).toBe('bad_chunk');
    expect(asm.ingest({ ...b!, fileId: 4 })).toBe('bad_chunk');
  });

  it('rejects cumulative bytes above the declared size', () => {
    const asm = new FileAssembler(1, 10, 1);
    expect(asm.ingest({ fileId: 1, chunkIndex: 0, payload: bytes(11) })).toBe('overflow');
  });

  it('refuses to finish with a missing chunk', () => {
    const asm = new FileAssembler(3, size, 3);
    const [a, , c] = frames();
    asm.ingest(a!);
    asm.ingest(c!);
    expect(asm.finish()).toEqual({ ok: false, reason: 'bad_chunk' });
  });
});

describe('offers', () => {
  it('makeOffer sanitises the name and passes the shared schema', () => {
    const o = makeOffer(1, 're:port<1>.pdf', 40000, 'application/pdf', 'a'.repeat(64), 1);
    expect(o.name).toBe('re_port_1_.pdf');
    expect(o.chunks).toBe(3);
    expect(dcFileOfferSchema.safeParse(o).success).toBe(true);
  });

  it('checkOffer enforces the name length and the 256 MiB cap', () => {
    expect(checkOffer({ fileId: 1, name: '', size: 1 })).toEqual({ ok: false, reason: 'bad_name' });
    expect(checkOffer({ fileId: 1, name: 'x'.repeat(256), size: 1 })).toEqual({ ok: false, reason: 'bad_name' });
    expect(checkOffer({ fileId: 1, name: 'a.txt', size: 256 * 1024 * 1024 + 1 })).toEqual({ ok: false, reason: 'too_large' });
    expect(checkOffer({ fileId: 2, name: 'CON', size: 1 })).toEqual({ ok: true, name: '_CON' });
  });
});

describe('hashing and sniffing', () => {
  it('sha256HexOf matches the known vector and the shared implementation', async () => {
    const abc = new TextEncoder().encode('abc');
    expect(await sha256HexOf(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const big = bytes(70000);
    expect(await sha256HexOf(big)).toBe(sha256Hex(big));
  });

  it('sniffs common types from magic bytes', () => {
    expect(sniffType(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBe('Windows executable (PE)');
    expect(sniffType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('PDF document');
    expect(sniffType(new TextEncoder().encode('hello world\n'))).toBe('text');
    expect(sniffType(new Uint8Array(0))).toBe('empty');
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});
