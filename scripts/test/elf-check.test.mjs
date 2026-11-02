// scripts/elf-check.mjs (Phase E section 7.9) on tiny synthetic ELF64 images built here: program headers with
// PT_LOAD, PT_INTERP and PT_DYNAMIC (no section headers, as in a stripped binary), a .dynstr, DT_NEEDED entries and a
// DT_VERNEED chain. Covers the pass, each failure (NEEDED outside the set, GLIBC_ above the floor, size) and the CLI.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ALLOWED_NEEDED, checkElf, compareVersions, parseGlibcVersion, readElf } from '../elf-check.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'elf-check.mjs');
const BASE = 0x400000n;

/**
 * Builds an ELF64 LE x86-64 image. `verneed` is `[{ file, versions: [name...] }]`; `strtabOutside` points DT_STRTAB
 * outside every PT_LOAD; `pad` appends zero bytes.
 */
function makeElf({ needed = [], verneed = [], interp = '/lib64/ld-linux-x86-64.so.2', machine = 62, pad = 0, dynamic = true, strtabOutside = false } = {}) {
  // .dynstr
  const strs = [Buffer.from([0])];
  let strLen = 1;
  const index = new Map();
  const addStr = (s) => {
    if (index.has(s)) return index.get(s);
    const at = strLen;
    strs.push(Buffer.from(`${s}\0`, 'latin1'));
    strLen += s.length + 1;
    index.set(s, at);
    return at;
  };
  const neededIdx = needed.map(addStr);
  const vn = verneed.map((v) => ({ file: addStr(v.file), names: v.versions.map(addStr) }));
  const dynstr = Buffer.concat(strs);

  // .gnu.version_r: each Verneed followed by its Vernaux entries.
  const verParts = [];
  vn.forEach((v, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt16LE(1, 0); // vn_version
    e.writeUInt16LE(v.names.length, 2);
    e.writeUInt32LE(v.file, 4);
    e.writeUInt32LE(16, 8); // vn_aux: right after this entry
    e.writeUInt32LE(i === vn.length - 1 ? 0 : 16 + 16 * v.names.length, 12);
    verParts.push(e);
    v.names.forEach((n, j) => {
      const a = Buffer.alloc(16);
      a.writeUInt32LE(0x0d696910 + j, 0); // vna_hash (not checked)
      a.writeUInt16LE(2 + j, 6); // vna_other
      a.writeUInt32LE(n, 8);
      a.writeUInt32LE(j === v.names.length - 1 ? 0 : 16, 12);
      verParts.push(a);
    });
  });
  const verneedBuf = Buffer.concat(verParts);

  const interpBuf = interp ? Buffer.from(`${interp}\0`, 'latin1') : Buffer.alloc(0);
  const phnum = 1 + (interp ? 1 : 0) + (dynamic ? 1 : 0);
  const phoff = 64;
  let off = phoff + 56 * phnum;
  const interpOff = off;
  off += interpBuf.length;
  const strOff = off;
  off += dynstr.length;
  off = Math.ceil(off / 8) * 8;
  const verOff = off;
  off += verneedBuf.length;
  off = Math.ceil(off / 8) * 8;
  const dynOff = off;
  const dynEntries = [];
  for (const n of neededIdx) dynEntries.push([1n, BigInt(n)]);
  dynEntries.push([5n, strtabOutside ? 0x10n : BASE + BigInt(strOff)]);
  dynEntries.push([10n, BigInt(dynstr.length)]);
  if (vn.length > 0) {
    dynEntries.push([0x6ffffffen, BASE + BigInt(verOff)]);
    dynEntries.push([0x6fffffffn, BigInt(vn.length)]);
  }
  dynEntries.push([0n, 0n]);
  const dynBuf = Buffer.alloc(16 * dynEntries.length);
  dynEntries.forEach(([tag, val], i) => {
    dynBuf.writeBigInt64LE(tag, 16 * i);
    dynBuf.writeBigUInt64LE(val, 16 * i + 8);
  });
  off += dynBuf.length;
  const total = off + pad;

  const img = Buffer.alloc(total);
  // ELF header
  img.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  img.writeUInt16LE(3, 16); // ET_DYN
  img.writeUInt16LE(machine, 18);
  img.writeUInt32LE(1, 20);
  img.writeBigUInt64LE(BASE + 0x1000n, 24); // e_entry
  img.writeBigUInt64LE(BigInt(phoff), 32);
  img.writeBigUInt64LE(0n, 40); // e_shoff: no section headers (stripped)
  img.writeUInt16LE(64, 52);
  img.writeUInt16LE(56, 54);
  img.writeUInt16LE(phnum, 56);
  img.writeUInt16LE(64, 58);
  img.writeUInt16LE(0, 60);
  let ph = phoff;
  const phdr = (type, flags, offset, size) => {
    img.writeUInt32LE(type, ph);
    img.writeUInt32LE(flags, ph + 4);
    img.writeBigUInt64LE(BigInt(offset), ph + 8);
    img.writeBigUInt64LE(BASE + BigInt(offset), ph + 16);
    img.writeBigUInt64LE(BASE + BigInt(offset), ph + 24);
    img.writeBigUInt64LE(BigInt(size), ph + 32);
    img.writeBigUInt64LE(BigInt(size), ph + 40);
    img.writeBigUInt64LE(8n, ph + 48);
    ph += 56;
  };
  phdr(1, 5, 0, total); // PT_LOAD covering the whole image
  if (interp) phdr(3, 4, interpOff, interpBuf.length);
  if (dynamic) phdr(2, 6, dynOff, dynBuf.length);
  interpBuf.copy(img, interpOff);
  dynstr.copy(img, strOff);
  verneedBuf.copy(img, verOff);
  if (dynamic) dynBuf.copy(img, dynOff);
  return img;
}

const GOOD = {
  needed: ['libc.so.6', 'libm.so.6', 'libgcc_s.so.1'],
  verneed: [
    { file: 'libgcc_s.so.1', versions: ['GCC_3.0', 'GCC_4.2.0'] },
    { file: 'libm.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.29'] },
    { file: 'libc.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.17', 'GLIBC_PRIVATE'] },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'elf-check-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function cli(img, ...args) {
  const p = join(dir, `bin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(p, img);
  const r = spawnSync(process.execPath, [SCRIPT, p, ...args], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null, stdout: r.stdout, stderr: r.stderr };
}

describe('elf-check: the reader', () => {
  it('reads interp, DT_NEEDED and every Vernaux name through program headers only', () => {
    const e = readElf(makeElf(GOOD));
    expect(e.dynamic).toBe(true);
    expect(e.interp).toBe('/lib64/ld-linux-x86-64.so.2');
    expect(e.needed).toEqual(['libc.so.6', 'libm.so.6', 'libgcc_s.so.1']);
    expect(e.versions.filter((v) => v.file === 'libc.so.6').map((v) => v.name)).toEqual(['GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.17', 'GLIBC_PRIVATE']);
    expect(e.versions).toHaveLength(8);
  });

  it('versions compare numerically (2.9 < 2.17 < 2.35 < 2.35.1)', () => {
    expect(parseGlibcVersion('GLIBC_2.2.5')).toEqual([2, 2, 5]);
    expect(parseGlibcVersion('GLIBC_PRIVATE')).toBeNull();
    expect(compareVersions([2, 9, 0], [2, 17, 0])).toBe(-1);
    expect(compareVersions(parseGlibcVersion('2.35'), parseGlibcVersion('GLIBC_2.35'))).toBe(0);
    expect(compareVersions([2, 35, 1], [2, 35, 0])).toBe(1);
  });
});

describe('elf-check: the gate', () => {
  it('passes: NEEDED inside the set, highest GLIBC_2.34 <= 2.35, small file', () => {
    const r = checkElf(makeElf(GOOD));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.glibc).toBe('2.34');
    expect(r.maxGlibc).toBe('2.35');
  });

  it('passes with every allowed library and exactly GLIBC_2.35', () => {
    const r = checkElf(makeElf({ needed: [...ALLOWED_NEEDED], verneed: [{ file: 'libc.so.6', versions: ['GLIBC_2.35'] }] }));
    expect(r.ok).toBe(true);
    expect(r.glibc).toBe('2.35');
  });

  it('passes a static image (no PT_DYNAMIC)', () => {
    const r = checkElf(makeElf({ dynamic: false, interp: null }));
    expect(r.ok).toBe(true);
    expect(r.needed).toEqual([]);
    expect(r.glibc).toBeNull();
  });

  it('fails on a DT_NEEDED library outside the set', () => {
    const r = checkElf(makeElf({ ...GOOD, needed: [...GOOD.needed, 'libX11.so.6', 'libasound.so.2'] }));
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/outside the allowed set: libX11\.so\.6, libasound\.so\.2/);
  });

  it('fails when a GLIBC_ version is above the floor (2.43 from a plain host build), and honours --max-glibc', () => {
    const img = makeElf({ ...GOOD, verneed: [...GOOD.verneed, { file: 'libc.so.6', versions: ['GLIBC_2.43'] }] });
    const r = checkElf(img);
    expect(r.ok).toBe(false);
    expect(r.glibc).toBe('2.43');
    expect(r.failures[0]).toMatch(/requires GLIBC_2\.43, newer than the GLIBC_2\.35 floor/);
    expect(checkElf(img, { maxGlibc: '2.43' }).ok).toBe(true);
    expect(checkElf(makeElf(GOOD), { maxGlibc: '2.33' }).ok).toBe(false);
  });

  it('fails when the file is larger than the size limit', () => {
    const r = checkElf(makeElf({ ...GOOD, pad: 4096 }), { maxSizeMib: 0.002 });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/more than the 0\.002 MiB limit/);
  });

  it('fails clearly on a file that is not an x86-64 ELF64 or is malformed', () => {
    expect(checkElf(Buffer.from('#!/bin/sh\necho hi\n'.padEnd(80, ' '))).failures[0]).toMatch(/bad magic/);
    const c32 = makeElf(GOOD);
    c32[4] = 1;
    expect(checkElf(c32).failures[0]).toMatch(/not an ELF64/);
    expect(checkElf(makeElf({ ...GOOD, machine: 183 })).failures[0]).toMatch(/not an x86-64 ELF/);
    expect(checkElf(makeElf({ ...GOOD, strtabOutside: true })).failures[0]).toMatch(/DT_STRTAB .* not inside a PT_LOAD/);
    expect(checkElf(makeElf(GOOD).subarray(0, 100)).ok).toBe(false);
  });
});

describe('elf-check: the CLI', () => {
  it('exit 0 and a one-line JSON summary on a pass', () => {
    const r = cli(makeElf(GOOD), '--max-glibc', '2.35', '--max-size-mib', '25');
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.json).toMatchObject({ ok: true, glibc: '2.34', maxGlibc: '2.35', maxSizeMiB: 25, needed: GOOD.needed, failures: [] });
    expect(r.stderr).toBe('');
  });

  it('exit 1 with the reason on stderr for each failure', () => {
    const needed = cli(makeElf({ ...GOOD, needed: ['libc.so.6', 'libvpx.so.9'] }));
    expect(needed.code).toBe(1);
    expect(needed.json.ok).toBe(false);
    expect(needed.stderr).toMatch(/FAIL: DT_NEEDED .*libvpx\.so\.9/);
    const glibc = cli(makeElf({ needed: ['libc.so.6'], verneed: [{ file: 'libc.so.6', versions: ['GLIBC_2.36'] }] }));
    expect(glibc.code).toBe(1);
    expect(glibc.stderr).toMatch(/FAIL: requires GLIBC_2\.36/);
    const size = cli(makeElf({ ...GOOD, pad: 8192 }), '--max-size-mib', '0.005');
    expect(size.code).toBe(1);
    expect(size.stderr).toMatch(/FAIL: the file is .* MiB/);
  });

  it('exit 2 on a usage error; exit 1 on a missing file', () => {
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(process.execPath, [SCRIPT, 'x', '--max-glibc', 'two'], { encoding: 'utf8' }).status).toBe(2);
    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, 'nope')], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/cannot read/);
  });
});
