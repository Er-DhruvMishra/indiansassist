#!/usr/bin/env node
/**
 * The Linux release gate (docs/specs/phase-e-contracts.md section 7.9): a pure Node ELF64 reader, no binutils.
 *
 *   node scripts/elf-check.mjs <path> [--max-glibc 2.35] [--max-size-mib 25] [--allow <soname>]...
 *
 * Phase F section 9.6: `--allow libpipewire-0.3.so.0` (repeatable) widens the NEEDED set by exactly that library, for the
 * Wayland portal companion, which links libpipewire; the E set stays the default for every other binary.
 *
 * The release binary is stripped, so everything is found through the **program headers** (never the section
 * headers): `PT_DYNAMIC` gives the dynamic table; its `DT_STRTAB` (a virtual address, mapped to a file offset
 * through the `PT_LOAD` segments) is the `.dynstr` the `DT_NEEDED` names and the `DT_VERNEED` (`.gnu.version_r`)
 * chain point into. The check passes only when
 *   - every `DT_NEEDED` entry is one of the allowed glibc / libgcc libraries below (plus each `--allow`),
 *   - the highest `GLIBC_x.y[.z]` version any `Vernaux` entry requires is at most `--max-glibc`, and
 *   - the file is at most `--max-size-mib` MiB.
 * It prints one line of JSON (stdout) either way, writes each failure to stderr and exits 1 on a failure (also
 * for a file that is not a well-formed x86-64 ELF64), 2 on a usage error. Read-only.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALLOWED_NEEDED = Object.freeze([
  'libc.so.6',
  'libm.so.6',
  'libgcc_s.so.1',
  'libpthread.so.0',
  'libdl.so.2',
  'librt.so.1',
  'ld-linux-x86-64.so.2',
]);
export const DEFAULT_MAX_GLIBC = '2.35';
export const DEFAULT_MAX_SIZE_MIB = 25;

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;
const EM_X86_64 = 62;
const MAX_ENTRIES = 1 << 16;

class ElfError extends Error {}

function reader(buf) {
  const need = (off, len, what) => {
    if (!Number.isSafeInteger(off) || off < 0 || off + len > buf.length) throw new ElfError(`malformed ELF: ${what} lies outside the file`);
  };
  return {
    u16: (off, what) => (need(off, 2, what), buf.readUInt16LE(off)),
    u32: (off, what) => (need(off, 4, what), buf.readUInt32LE(off)),
    u64: (off, what) => (need(off, 8, what), buf.readBigUInt64LE(off)),
    i64: (off, what) => (need(off, 8, what), buf.readBigInt64LE(off)),
    need,
  };
}

const toNum = (big, what) => {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new ElfError(`malformed ELF: ${what} is out of range`);
  return Number(big);
};

/** `GLIBC_2.35` -> [2, 35, 0]; null for a non-numeric version such as `GLIBC_PRIVATE`. */
export function parseGlibcVersion(name) {
  const m = /^(?:GLIBC_)?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Reads an ELF64 little-endian x86-64 image: its interpreter, `DT_NEEDED` names and the `GLIBC_` versions its
 * `DT_VERNEED` chain requires. Throws `ElfError` on anything malformed.
 */
export function readElf(buf) {
  const r = reader(buf);
  r.need(0, 64, 'the ELF header');
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) throw new ElfError('not an ELF file (bad magic)');
  if (buf[4] !== 2) throw new ElfError('not an ELF64 file (EI_CLASS is not ELFCLASS64)');
  if (buf[5] !== 1) throw new ElfError('not a little-endian ELF file (EI_DATA is not ELFDATA2LSB)');
  const machine = r.u16(18, 'e_machine');
  if (machine !== EM_X86_64) throw new ElfError(`not an x86-64 ELF (e_machine ${machine})`);
  const phoff = toNum(r.u64(32, 'e_phoff'), 'e_phoff');
  const phentsize = r.u16(54, 'e_phentsize');
  const phnum = r.u16(56, 'e_phnum');
  if (phnum > 0 && phentsize < 56) throw new ElfError('malformed ELF: e_phentsize is smaller than an Elf64_Phdr');

  const loads = [];
  let dynamic = null;
  let interp = null;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    r.need(p, 56, `program header ${i}`);
    const type = r.u32(p, 'p_type');
    const offset = toNum(r.u64(p + 8, 'p_offset'), 'p_offset');
    const vaddr = r.u64(p + 16, 'p_vaddr');
    const filesz = toNum(r.u64(p + 32, 'p_filesz'), 'p_filesz');
    if (type === PT_LOAD) loads.push({ offset, vaddr, filesz });
    else if (type === PT_DYNAMIC) dynamic = { offset, filesz };
    else if (type === PT_INTERP) {
      r.need(offset, filesz, 'PT_INTERP');
      const s = buf.subarray(offset, offset + filesz);
      const z = s.indexOf(0);
      interp = s.subarray(0, z < 0 ? s.length : z).toString('latin1');
    }
  }
  if (!dynamic) return { interp, needed: [], versions: [], dynamic: false };

  /** A virtual address inside a PT_LOAD segment -> its file offset. */
  const fileOffset = (addr, what) => {
    for (const l of loads) {
      if (addr >= l.vaddr && addr < l.vaddr + BigInt(l.filesz)) return l.offset + Number(addr - l.vaddr);
    }
    throw new ElfError(`malformed ELF: ${what} (0x${addr.toString(16)}) is not inside a PT_LOAD segment`);
  };

  const tags = { needed: [], strtab: null, strsz: null, verneed: null, verneednum: null };
  r.need(dynamic.offset, dynamic.filesz, 'PT_DYNAMIC');
  const dynEnd = dynamic.offset + dynamic.filesz;
  for (let off = dynamic.offset, n = 0; off + 16 <= dynEnd && n < MAX_ENTRIES; off += 16, n++) {
    const tag = r.i64(off, 'd_tag');
    const val = r.u64(off + 8, 'd_val');
    if (tag === DT_NULL) break;
    if (tag === DT_NEEDED) tags.needed.push(val);
    else if (tag === DT_STRTAB) tags.strtab = val;
    else if (tag === DT_STRSZ) tags.strsz = val;
    else if (tag === DT_VERNEED) tags.verneed = val;
    else if (tag === DT_VERNEEDNUM) tags.verneednum = val;
  }
  if ((tags.needed.length > 0 || tags.verneed !== null) && tags.strtab === null) throw new ElfError('malformed ELF: DT_NEEDED or DT_VERNEED without DT_STRTAB');

  const strOff = tags.strtab === null ? 0 : fileOffset(tags.strtab, 'DT_STRTAB');
  const strEnd = tags.strsz === null ? buf.length : Math.min(buf.length, strOff + toNum(tags.strsz, 'DT_STRSZ'));
  const str = (idx, what) => {
    const at = strOff + toNum(idx, what);
    if (at >= strEnd) throw new ElfError(`malformed ELF: ${what} points outside .dynstr`);
    const z = buf.indexOf(0, at);
    if (z < 0 || z >= strEnd) throw new ElfError(`malformed ELF: ${what} is not NUL-terminated inside .dynstr`);
    return buf.subarray(at, z).toString('latin1');
  };

  const needed = tags.needed.map((v) => str(v, 'a DT_NEEDED name'));
  const versions = [];
  if (tags.verneed !== null) {
    const count = tags.verneednum === null ? MAX_ENTRIES : Math.min(MAX_ENTRIES, toNum(tags.verneednum, 'DT_VERNEEDNUM'));
    let vn = fileOffset(tags.verneed, 'DT_VERNEED');
    for (let i = 0; i < count; i++) {
      r.need(vn, 16, 'an Elf64_Verneed');
      const cnt = r.u16(vn + 2, 'vn_cnt');
      const file = str(BigInt(r.u32(vn + 4, 'vn_file')), 'vn_file');
      const aux = r.u32(vn + 8, 'vn_aux');
      const next = r.u32(vn + 12, 'vn_next');
      let va = vn + aux;
      for (let j = 0; j < cnt; j++) {
        r.need(va, 16, 'an Elf64_Vernaux');
        versions.push({ file, name: str(BigInt(r.u32(va + 8, 'vna_name')), 'vna_name') });
        const vnext = r.u32(va + 12, 'vna_next');
        if (vnext === 0) break;
        va += vnext;
      }
      if (next === 0) break;
      vn += next;
    }
  }
  return { interp, needed, versions, dynamic: true };
}

/** Runs the section 7.9 gate on an image; never throws (a malformed file is a failure). */
export function checkElf(buf, { maxGlibc = DEFAULT_MAX_GLIBC, maxSizeMib = DEFAULT_MAX_SIZE_MIB, allow = [] } = {}) {
  const allowed = [...ALLOWED_NEEDED, ...allow];
  const failures = [];
  const max = parseGlibcVersion(maxGlibc);
  if (!max) throw new Error(`--max-glibc must look like 2.35, got "${maxGlibc}"`);
  const size = buf.length;
  const summary = { ok: false, size, sizeMiB: Math.round((size / 1048576) * 100) / 100, maxSizeMiB: maxSizeMib, maxGlibc, glibc: null, needed: [], interp: null };
  if (size > maxSizeMib * 1048576) failures.push(`the file is ${summary.sizeMiB} MiB, more than the ${maxSizeMib} MiB limit`);
  let elf = null;
  try {
    elf = readElf(buf);
  } catch (err) {
    if (!(err instanceof ElfError)) throw err;
    failures.push(err.message);
  }
  if (elf) {
    summary.needed = elf.needed;
    summary.interp = elf.interp;
    const extra = elf.needed.filter((n) => !allowed.includes(n));
    if (extra.length > 0) failures.push(`DT_NEEDED has libraries outside the allowed set: ${extra.join(', ')} (allowed: ${allowed.join(', ')})`);
    let highest = null;
    for (const v of elf.versions) {
      if (!v.name.startsWith('GLIBC_')) continue;
      const p = parseGlibcVersion(v.name);
      if (p && (!highest || compareVersions(p, highest.v) > 0)) highest = { v: p, name: v.name };
    }
    summary.glibc = highest ? highest.name.slice('GLIBC_'.length) : null;
    if (highest && compareVersions(highest.v, max) > 0) failures.push(`requires ${highest.name}, newer than the GLIBC_${maxGlibc} floor`);
  }
  summary.ok = failures.length === 0;
  return { ...summary, failures };
}

function parseArgs(argv) {
  const out = { path: null, maxGlibc: DEFAULT_MAX_GLIBC, maxSizeMib: DEFAULT_MAX_SIZE_MIB, allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-glibc') out.maxGlibc = argv[++i];
    else if (a === '--max-size-mib') out.maxSizeMib = Number(argv[++i]);
    else if (a === '--allow') {
      const so = argv[++i];
      // A shared-object name only (`libfoo.so.N`), never a path or a pattern.
      if (!so || !/^lib[A-Za-z0-9_.+-]+\.so(?:\.\d+)*$/.test(so)) throw new Error('--allow wants a library soname such as libpipewire-0.3.so.0');
      out.allow.push(so);
    }
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (out.path === null) out.path = a;
    else throw new Error('one path only');
  }
  if (!out.path) throw new Error('a path is required');
  if (!out.maxGlibc || !parseGlibcVersion(out.maxGlibc)) throw new Error('--max-glibc must look like 2.35');
  if (!Number.isFinite(out.maxSizeMib) || out.maxSizeMib <= 0) throw new Error('--max-size-mib must be a positive number');
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`elf-check: ${err.message}\nusage: node scripts/elf-check.mjs <path> [--max-glibc 2.35] [--max-size-mib 25] [--allow <soname>]\n`);
    return 2;
  }
  let buf;
  try {
    buf = readFileSync(args.path);
  } catch (err) {
    process.stderr.write(`elf-check: cannot read ${args.path}: ${err.code ?? err.message}\n`);
    return 1;
  }
  const res = checkElf(buf, { maxGlibc: args.maxGlibc, maxSizeMib: args.maxSizeMib, allow: args.allow });
  process.stdout.write(`${JSON.stringify({ file: basename(args.path), ...res })}\n`);
  for (const f of res.failures) process.stderr.write(`elf-check: FAIL: ${f}\n`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
