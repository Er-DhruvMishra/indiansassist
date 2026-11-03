/**
 * The per-download macOS zip (docs/specs/phase-f-contracts.md section 17.2, stream apple): the members of the signed
 * `IndiansAssist.app` from the dist zip (`IndiansAssist-macos-<arch>-<v>.app.zip`, built by
 * `agent/scripts/macos-zip.sh` with stored members) followed by the per-download signed sidecar
 * `IndiansAssist.iaconfig` beside the bundle, which is the macOS carrier of the desk code (the zip's own name is gone
 * once it is extracted).
 *
 * Every member is stored (method 0), so the archive is a concatenation of fixed parts:
 *
 * - the bundle's local records, cut from the dist zip once (on the first download of a build) and cached;
 * - the sidecar's local record, built per request;
 * - the dist zip's central directory, unchanged (the bundle's offsets do not move);
 * - the sidecar's central record and the end-of-central-directory record, built per request.
 *
 * The sidecar's signature is Ed25519, which is deterministic, so the bytes are a pure function of the grant and
 * `Range` / `HEAD` work as for the other builds. Only Zip 2.0 features: no Zip64, no data descriptors, no encryption.
 */
import { readFileSync } from 'node:fs';
import { crc32 } from './linux-archive.js';

export const MACOS_SIDECAR_NAME = 'IndiansAssist.iaconfig';
const BUNDLE_PREFIX = 'IndiansAssist.app/';
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 2026-01-01 00:00 in MS-DOS form, the timestamp `macos-zip.sh` gives every member. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
/** Version made by: 3 (Unix) in the high byte, 2.0 in the low byte. */
const MADE_BY = (3 << 8) | 20;
const VERSION_NEEDED = 10;

/** What a build caches: the bundle's local records and the central directory that indexes them. */
export type MacZipBody = { local: Buffer; central: Buffer; count: number };

/**
 * Cuts a dist zip into its cached parts. Throws unless every member is stored, unencrypted, without a data
 * descriptor, and under `IndiansAssist.app/`, and the zip has no comment and no Zip64 records.
 */
export function macZipBody(zip: Buffer): MacZipBody {
  if (zip.length < 22) throw new Error('not a zip');
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== EOCD_SIG) throw new Error('the zip has a comment or no end record');
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt16LE(eocd + 8) !== count || count === 0xffff || cdOffset === 0xffffffff)
    throw new Error('multi-disk or Zip64 archives are not served');
  if (cdOffset + cdSize !== eocd) throw new Error('the central directory does not end at the end record');
  let off = cdOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(off) !== CENTRAL_SIG) throw new Error('bad central record');
    const flags = zip.readUInt16LE(off + 8);
    const method = zip.readUInt16LE(off + 10);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const localOffset = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error(`member ${name} is not stored`);
    if (flags & 0x0009) throw new Error(`member ${name} is encrypted or has a data descriptor`);
    if (!name.startsWith(BUNDLE_PREFIX) || name.includes('..')) throw new Error(`member ${name} is outside the bundle`);
    if (localOffset >= cdOffset || zip.readUInt32LE(localOffset) !== LOCAL_SIG)
      throw new Error(`bad local record for ${name}`);
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (off !== eocd) throw new Error('the central directory has trailing bytes');
  return { local: zip.subarray(0, cdOffset), central: zip.subarray(cdOffset, eocd), count };
}

/** One stored member's local and central records (mode 0644), with its local record at `offset`. */
export function storedMember(name: string, data: Buffer, offset: number): { local: Buffer; central: Buffer } {
  const n = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(VERSION_NEEDED, 4);
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_SIG, 0);
  central.writeUInt16LE(MADE_BY, 4);
  central.writeUInt16LE(VERSION_NEEDED, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(n.length, 28);
  // extra 0, comment 0, disk 0, internal attributes 0
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attributes: a regular file, rw-r--r--
  central.writeUInt32LE(offset, 42);
  return { local: Buffer.concat([local, n, data]), central: Buffer.concat([central, n]) };
}

/** The parts of one download: the cached bundle records plus the signed sidecar beside the bundle. */
export function macZipParts(body: MacZipBody, sidecar: string): Buffer[] {
  const member = storedMember(MACOS_SIDECAR_NAME, Buffer.from(sidecar, 'utf8'), body.local.length);
  const cdOffset = body.local.length + member.local.length;
  const cdSize = body.central.length + member.central.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(body.count + 1, 8);
  eocd.writeUInt16LE(body.count + 1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return [body.local, member.local, body.central, member.central, eocd];
}

/** The cached bodies, by dist path and digest (a reload that changes the file changes the digest). */
const cache = new Map<string, MacZipBody>();

/** The cached body of a served macOS build, cut on first use; null when the dist zip is not servable. */
export function macZipBodyFor(build: { path: string; sha256: string }): MacZipBody | null {
  const key = `${build.path}\n${build.sha256}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const body = macZipBody(readFileSync(build.path));
    cache.set(key, body);
    return body;
  } catch {
    return null;
  }
}
