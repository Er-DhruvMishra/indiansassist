/**
 * Phase E section 7.6 (stream linux): the per-download Linux `.tar.gz`. The header bytes of both gzip members, the
 * archive extracted with tar semantics through the pure-JS ustar reader below, `Content-Length`, `HEAD`, `Range`,
 * the served name and content type, and the C section 2.2 `410` and `503` answers.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { agentLinuxFileName, parseAgentLinuxFileName, sha256Hex } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32, gzipMember, linuxArchiveBody, linuxArchiveHead, sliceParts, ustarHeader } from '../src/services/linux-archive.js';
import type { Account, TestApp } from './helpers.js';
import { call } from './helpers.js';
import { makeP3App, p3Admin, p3Token } from './p3-kit.js';

let t: TestApp;
let admin: Account;

/** A fake ELF whose length is not a multiple of 512 (so the padding is exercised). */
function fakeElf(seed: number, len = 1300): Buffer {
  const b = Buffer.alloc(len);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  for (let i = 16; i < len; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
const ELF = fakeElf(7);

beforeAll(async () => {
  t = await makeP3App();
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});

function writeDist(elf: Buffer, opts: { linux?: boolean; windows?: boolean } = { linux: true, windows: true }): void {
  const dir = t.ctx.config.agent.distDir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const builds: unknown[] = [];
  if (opts.linux) {
    writeFileSync(join(dir, 'IndiansAssist-linux-x64-0.5.0'), elf);
    builds.push({ platform: 'linux', arch: 'x64', version: '0.5.0', size: 1, sha256: sha256Hex(elf), signed: false, minOs: 'glibc 2.35' });
  }
  if (opts.windows) {
    const exe = Buffer.from('MZ fake windows build');
    writeFileSync(join(dir, 'IndiansAssist-windows-x64-0.5.0.exe'), exe);
    builds.push({ platform: 'windows', arch: 'x64', version: '0.5.0', size: 1, sha256: sha256Hex(exe), signed: false, minOs: '10.0.17763' });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, builds }));
  t.ctx.agentDist.load();
}

async function prepare(code: string, over: Record<string, unknown> = {}) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/download/prepare',
    remoteAddress: '127.0.0.1',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'IndiansAssist' },
    payload: JSON.stringify({ code, platform: 'linux', arch: 'x64', ...over }),
  });
}

const grantPath = (u: string) => new URL(u).pathname;

// ---------- a small pure-JS tar reader (POSIX ustar), used on the gunzipped stream ----------

type TarEntry = { name: string; mode: number; uid: number; gid: number; size: number; mtime: number; type: string; uname: string; gname: string; data: Buffer };

const cstr = (b: Buffer, off: number, len: number) => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? len : z).toString('ascii');
};
const num = (b: Buffer, off: number, len: number) => parseInt(cstr(b, off, len).trim() || '0', 8);

function readTar(buf: Buffer): { entries: TarEntry[]; trailingZeroBlocks: number; rest: number } {
  const entries: TarEntry[] = [];
  let off = 0;
  let zeros = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) {
      zeros++;
      off += 512;
      if (zeros === 2) break;
      continue;
    }
    if (zeros > 0) throw new Error('a lone zero block inside the archive');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== num(h, 148, 8)) throw new Error('tar header checksum mismatch');
    if (cstr(h, 257, 6) !== 'ustar' || h.subarray(263, 265).toString('ascii') !== '00') throw new Error('not a POSIX ustar header');
    const size = num(h, 124, 12);
    const prefix = cstr(h, 345, 155);
    const name = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    if (data.length !== size) throw new Error('truncated member');
    entries.push({
      name,
      mode: num(h, 100, 8),
      uid: num(h, 108, 8),
      gid: num(h, 116, 8),
      size,
      mtime: num(h, 136, 12),
      type: String.fromCharCode(h[156]!),
      uname: cstr(h, 265, 32),
      gname: cstr(h, 297, 32),
      data,
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, trailingZeroBlocks: zeros, rest: buf.length - off };
}

/** Splits a concatenation of gzip members (each: 10-byte plain header, raw deflate, 8-byte trailer). */
function gzipMembers(buf: Buffer): { header: Buffer; data: Buffer; crc: number; isize: number; length: number }[] {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    const header = buf.subarray(off, off + 10);
    if (header[3] !== 0) throw new Error('the test splitter handles only flag-less members');
    const { buffer, engine } = zlib.inflateRawSync(buf.subarray(off + 10), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const end = off + 10 + engine.bytesWritten;
    out.push({ header, data: buffer, crc: buf.readUInt32LE(end), isize: buf.readUInt32LE(end + 4), length: end + 8 - off });
    off = end + 8;
  }
  return out;
}

const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);

describe('linux-archive (pure)', () => {
  it('crc32 matches the well-known check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('ustar header bytes: name, mode 0755, uid/gid 0, size, mtime 0, type 0, ustar 00, root/root, checksum', () => {
    const h = ustarHeader('IndiansAssist-in-mum-4821-9365-7715', 1300);
    expect(h.length).toBe(512);
    expect(cstr(h, 0, 100)).toBe('IndiansAssist-in-mum-4821-9365-7715');
    expect(h.subarray(100, 108).toString('latin1')).toBe('0000755\0');
    expect(h.subarray(108, 116).toString('latin1')).toBe('0000000\0');
    expect(h.subarray(116, 124).toString('latin1')).toBe('0000000\0');
    expect(h.subarray(124, 136).toString('latin1')).toBe(`${(1300).toString(8).padStart(11, '0')}\0`);
    expect(h.subarray(136, 148).toString('latin1')).toBe('00000000000\0');
    expect(h[156]).toBe(0x30);
    expect(h.subarray(257, 265).toString('latin1')).toBe('ustar\x0000');
    expect(cstr(h, 265, 32)).toBe('root');
    expect(cstr(h, 297, 32)).toBe('root');
    expect(h[154]).toBe(0);
    expect(h[155]).toBe(0x20);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    expect(parseInt(h.subarray(148, 154).toString('ascii'), 8)).toBe(sum);
    expect(() => ustarHeader('', 1)).toThrow();
    expect(() => ustarHeader('a'.repeat(101), 1)).toThrow();
  });

  it('gzip members are deterministic: mtime 0, no flags, XFL 0, OS 255, CRC and ISIZE trailer', () => {
    const data = Buffer.from('hello hello hello');
    const a = gzipMember(data);
    expect(a.equals(gzipMember(data))).toBe(true);
    expect(a.subarray(0, 10).equals(GZIP_HEADER)).toBe(true);
    expect(a.readUInt32LE(a.length - 8)).toBe(crc32(data));
    expect(a.readUInt32LE(a.length - 4)).toBe(data.length);
    expect(zlib.gunzipSync(a).equals(data)).toBe(true);
  });

  it('the body member is the ELF padded to 512 plus two zero blocks; sliceParts covers any range without copying', () => {
    const body = linuxArchiveBody(ELF);
    expect(body.elfSize).toBe(1300);
    const raw = zlib.gunzipSync(body.member);
    expect(raw.length).toBe(1536 + 1024);
    expect(raw.subarray(0, 1300).equals(ELF)).toBe(true);
    expect(raw.subarray(1300).every((x) => x === 0)).toBe(true);
    const parts = [Buffer.from('abc'), Buffer.from('defgh'), Buffer.from('ij')];
    expect(Buffer.concat(sliceParts(parts, 0, 9)).toString()).toBe('abcdefghij');
    expect(Buffer.concat(sliceParts(parts, 2, 3)).toString()).toBe('cd');
    expect(Buffer.concat(sliceParts(parts, 8, 9)).toString()).toBe('ij');
    expect(sliceParts(parts, 4, 6)).toHaveLength(1);
  });

  it('an ELF of an exact 512 multiple gets no extra padding block', () => {
    const elf = fakeElf(1, 1024);
    expect(zlib.gunzipSync(linuxArchiveBody(elf).member).length).toBe(1024 + 1024);
  });
});

describe('linux download (C section 2.2 with the Phase E section 7.6 archive)', () => {
  it('without a Linux build: 503 download_unavailable on prepare (no dist dir, then a Windows-only manifest)', async () => {
    const { compact } = await p3Token(t, admin);
    const r1 = await prepare(compact);
    expect(r1.statusCode).toBe(503);
    expect(r1.json().error.code).toBe('download_unavailable');
    writeDist(ELF, { windows: true });
    const r2 = await prepare(compact);
    expect(r2.statusCode).toBe(503);
    expect(r2.json().error.code).toBe('download_unavailable');
    // Linux has x64 only (E W81).
    expect((await prepare(compact, { arch: 'arm64' })).statusCode).toBe(400);
    expect((await prepare(compact, { arch: 'universal' })).statusCode).toBe(400);
  });

  it('manifest: the Linux build with the raw ELF size and sha256', async () => {
    writeDist(ELF);
    const m = (await call(t.app, '/api/v1/download/manifest')).json();
    const linux = m.builds.find((b: { platform: string }) => b.platform === 'linux');
    expect(linux).toEqual({ platform: 'linux', arch: 'x64', version: '0.5.0', size: ELF.length, sha256: sha256Hex(ELF), signed: false, minOs: 'glibc 2.35' });
    expect(Object.keys(linux)).not.toContain('archive');
  });

  it('served archive: name, type, two gzip members, tar semantics, Content-Length, HEAD, Range, 3 GETs then 410', async () => {
    writeDist(ELF);
    const { compact } = await p3Token(t, admin, 'timed');
    const res = await prepare(compact);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const inner = agentLinuxFileName('in-mum', body.deskCode);
    expect(body.filename).toBe(`${inner}.tar.gz`);
    expect(body.filename).toMatch(/^IndiansAssist-in-mum-\d{4}-\d{4}-\d{4}\.tar\.gz$/);
    expect(parseAgentLinuxFileName(inner)).toEqual({ region: 'in-mum', deskCode: body.deskCode });
    expect(body.sha256).toBe(sha256Hex(ELF));
    expect(body.version).toBe('0.5.0');
    expect(body.signed).toBe(false);
    const path = grantPath(body.url);

    const head = await t.app.inject({ method: 'HEAD', url: path });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload.length).toBe(0);

    const g1 = await t.app.inject({ method: 'GET', url: path });
    expect(g1.statusCode).toBe(200);
    const archive = g1.rawPayload;
    expect(g1.headers['content-type']).toBe('application/gzip');
    expect(g1.headers['content-disposition']).toBe(`attachment; filename="${body.filename}"`);
    expect(g1.headers['content-length']).toBe(String(archive.length));
    expect(head.headers['content-length']).toBe(String(archive.length));
    expect(head.headers['content-type']).toBe('application/gzip');
    expect(g1.headers['accept-ranges']).toBe('bytes');
    expect(g1.headers['x-content-type-options']).toBe('nosniff');
    expect(g1.headers['cache-control']).toBe('private, no-store');
    expect(g1.headers['content-security-policy']).toContain('sandbox');

    // Two members, each with the deterministic header; member 1 is exactly the 512-byte ustar header.
    const members = gzipMembers(archive);
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m.header.equals(GZIP_HEADER)).toBe(true);
      expect(m.crc).toBe(crc32(m.data));
      expect(m.isize).toBe(m.data.length);
    }
    expect(members[0]!.data.length).toBe(512);
    expect(members[0]!.data.equals(ustarHeader(inner, ELF.length))).toBe(true);
    expect(members[1]!.data.length).toBe(1536 + 1024);
    expect(members[0]!.length + members[1]!.length).toBe(archive.length);
    expect(archive.subarray(0, members[0]!.length).equals(linuxArchiveHead(inner, ELF.length))).toBe(true);

    // gunzip reads the concatenation as one stream; the tar reader extracts one 0755 file with the ELF bytes.
    const tar = readTar(zlib.gunzipSync(archive));
    expect(tar.entries).toHaveLength(1);
    const e = tar.entries[0]!;
    expect(e).toMatchObject({ name: inner, mode: 0o755, uid: 0, gid: 0, size: ELF.length, mtime: 0, type: '0', uname: 'root', gname: 'root' });
    expect(e.data.equals(ELF)).toBe(true);
    expect(tar.trailingZeroBlocks).toBe(2);
    expect(tar.rest).toBe(0);

    // Range: a slice across the member boundary, a suffix range, and an unsatisfiable range.
    const cut = members[0]!.length;
    const g2 = await t.app.inject({ method: 'GET', url: path, headers: { range: `bytes=${cut - 5}-${cut + 9}` } });
    expect(g2.statusCode).toBe(206);
    expect(g2.headers['content-range']).toBe(`bytes ${cut - 5}-${cut + 9}/${archive.length}`);
    expect(g2.headers['content-length']).toBe('15');
    expect(g2.rawPayload.equals(archive.subarray(cut - 5, cut + 10))).toBe(true);
    const tailHead = await t.app.inject({ method: 'HEAD', url: path, headers: { range: 'bytes=-20' } });
    expect(tailHead.statusCode).toBe(206);
    expect(tailHead.headers['content-range']).toBe(`bytes ${archive.length - 20}-${archive.length - 1}/${archive.length}`);
    const bad = await t.app.inject({ method: 'HEAD', url: path, headers: { range: `bytes=${archive.length}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${archive.length}`);

    // The bytes are a pure function of the grant: a resumed download from the middle completes the same file.
    const g3 = await t.app.inject({ method: 'GET', url: path, headers: { range: `bytes=100-` } });
    expect(Buffer.concat([archive.subarray(0, 100), g3.rawPayload]).equals(archive)).toBe(true);

    const g4 = await t.app.inject({ method: 'GET', url: path });
    expect(g4.statusCode).toBe(410);
    expect(g4.json().error.code).toBe('link_expired');
  });

  it('another grant shares the cached body member and differs only in the header member', async () => {
    writeDist(ELF);
    const a = (await prepare((await p3Token(t, admin, 'timed')).compact)).json();
    const b = (await prepare((await p3Token(t, admin, 'timed')).compact)).json();
    const ga = (await t.app.inject({ method: 'GET', url: grantPath(a.url) })).rawPayload;
    const gb = (await t.app.inject({ method: 'GET', url: grantPath(b.url) })).rawPayload;
    const body = t.ctx.agentDist.find('linux', 'x64')!.archive!.member;
    expect(ga.subarray(ga.length - body.length).equals(body)).toBe(true);
    expect(gb.subarray(gb.length - body.length).equals(body)).toBe(true);
    expect(readTar(zlib.gunzipSync(gb)).entries[0]!.name).toBe(agentLinuxFileName('in-mum', b.deskCode));
    expect(a.deskCode).not.toBe(b.deskCode);
  });

  it('410 after the reload replaces the build (sha256 changed), after another IP, and for an unknown grant', async () => {
    writeDist(ELF);
    const body = (await prepare((await p3Token(t, admin, 'timed')).compact)).json();
    const path = grantPath(body.url);
    expect((await t.app.inject({ method: 'GET', url: path, remoteAddress: '10.9.9.9' })).statusCode).toBe(410);
    writeDist(fakeElf(9));
    const r = await t.app.inject({ method: 'GET', url: path });
    expect(r.statusCode).toBe(410);
    expect(r.json().error.code).toBe('link_expired');
    expect((await t.app.inject({ method: 'HEAD', url: path })).statusCode).toBe(410);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/download/' + 'B'.repeat(43) })).statusCode).toBe(410);
    // After the reload the new body member is what a new grant serves.
    const again = (await prepare((await p3Token(t, admin, 'timed')).compact)).json();
    const g = (await t.app.inject({ method: 'GET', url: grantPath(again.url) })).rawPayload;
    expect(readTar(zlib.gunzipSync(g)).entries[0]!.data.equals(fakeElf(9))).toBe(true);
  });

  it('the Windows build next to it is unchanged', async () => {
    writeDist(ELF);
    const body = (await prepare((await p3Token(t, admin, 'timed')).compact, { platform: 'windows' })).json();
    expect(body.filename).toMatch(/^IndiansAssist-in-mum-\d{4}-\d{4}-\d{4}\.exe$/);
    const g = await t.app.inject({ method: 'GET', url: grantPath(body.url) });
    expect(g.headers['content-type']).toBe('application/vnd.microsoft.portable-executable');
    expect(g.rawPayload.toString()).toBe('MZ fake windows build');
  });
});
