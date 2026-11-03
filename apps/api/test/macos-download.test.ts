/**
 * Phase F section 17.2 (stream apple): the per-download macOS zip. The bundle's stored members come from the dist zip
 * unchanged, the signed sidecar `IndiansAssist.iaconfig` beside the bundle carries the grant's desk code, the archive
 * is read back through the pure-JS zip reader below (and `unzip -t` where the host has it), and the served name,
 * content type, `HEAD`, `Range` and determinism hold as for the other builds.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicKeyEntry, sha256Hex, verifyIaconfig } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32 } from '../src/services/linux-archive.js';
import { MACOS_SIDECAR_NAME, macZipBody, macZipParts, storedMember } from '../src/services/macos-archive.js';
import type { Account, TestApp } from './helpers.js';
import { makeP3App, p3Admin, p3Token } from './p3-kit.js';

let t: TestApp;
let admin: Account;

beforeAll(async () => {
  t = await makeP3App();
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});

/** A stored zip of `members` with a central directory and end record, as `macos-zip.sh` writes it. */
function storedZip(members: [string, Buffer][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, data] of members) {
    const m = storedMember(name, data, off);
    locals.push(m.local);
    centrals.push(m.central);
    off += m.local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, central, eocd]);
}

const EXE = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37) & 0xff));
const PLIST = Buffer.from('<?xml version="1.0"?><plist><dict/></plist>\n');
const BUNDLE: [string, Buffer][] = [
  ['IndiansAssist.app/Contents/Info.plist', PLIST],
  ['IndiansAssist.app/Contents/MacOS/IndiansAssist', EXE],
];
const DIST = storedZip(BUNDLE);

type ZipEntry = { name: string; data: Buffer; crc: number; method: number };

/** Reads a zip through its central directory, checking each local record against it. */
function readZip(zip: Buffer): ZipEntry[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(off)).toBe(0x02014b50);
    const method = zip.readUInt16LE(off + 10);
    const crc = zip.readUInt32LE(off + 16);
    const size = zip.readUInt32LE(off + 24);
    const nameLen = zip.readUInt16LE(off + 28);
    const skip = zip.readUInt16LE(off + 30) + zip.readUInt16LE(off + 32);
    const local = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const lName = zip.readUInt16LE(local + 26);
    const lExtra = zip.readUInt16LE(local + 28);
    expect(zip.subarray(local + 30, local + 30 + lName).toString('utf8')).toBe(name);
    const start = local + 30 + lName + lExtra;
    out.push({ name, data: zip.subarray(start, start + size), crc, method });
    off += 46 + nameLen + skip;
  }
  return out;
}

function writeDist(): void {
  const dir = t.ctx.config.agent.distDir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IndiansAssist-macos-arm64-0.5.0.app.zip'), DIST);
  const builds = [
    {
      platform: 'macos',
      arch: 'arm64',
      version: '0.5.0',
      size: 1,
      sha256: sha256Hex(DIST),
      signed: false,
      minOs: '13.0',
    },
  ];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, builds }));
  t.ctx.agentDist.load();
}

async function prepare(code: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/download/prepare',
    remoteAddress: '127.0.0.1',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'IndiansAssist' },
    payload: JSON.stringify({ code, platform: 'macos', arch: 'arm64' }),
  });
}

describe('macOS zip parts (section 17.2)', () => {
  it('cuts a dist zip into its local records and central directory, and refuses what it cannot serve', () => {
    const body = macZipBody(DIST);
    expect(body.count).toBe(2);
    expect(Buffer.concat([body.local, body.central]).length).toBe(DIST.length - 22);
    expect(() => macZipBody(Buffer.from('not a zip at all, not even close'))).toThrow();
    expect(() => macZipBody(storedZip([['Other.app/x', EXE]]))).toThrow(/outside the bundle/);
    expect(() => macZipBody(storedZip([['IndiansAssist.app/../x', EXE]]))).toThrow(/outside the bundle/);
    const deflated = Buffer.from(DIST);
    deflated.writeUInt16LE(8, macZipBody(DIST).local.length + 10); // the first central record's method
    expect(() => macZipBody(deflated)).toThrow(/not stored/);
  });

  it('adds the sidecar after the bundle members, keeps their offsets, and stays deterministic', () => {
    const body = macZipBody(DIST);
    const zip = Buffer.concat(macZipParts(body, '{"v":1}'));
    expect(zip.equals(Buffer.concat(macZipParts(body, '{"v":1}')))).toBe(true);
    expect(zip.subarray(0, body.local.length).equals(body.local)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([...BUNDLE.map(([n]) => n), MACOS_SIDECAR_NAME]);
    for (const e of entries) {
      expect(e.method).toBe(0);
      expect(e.crc).toBe(crc32(e.data));
    }
    expect(entries[1]!.data.equals(EXE)).toBe(true);
    expect(entries[2]!.data.toString()).toBe('{"v":1}');
  });
});

describe('macOS download (C section 2.2 with the Phase F section 17.2 zip)', () => {
  it('serves the zip: name, type, the signed sidecar with this desk code, HEAD, Range', async () => {
    writeDist();
    const { compact } = await p3Token(t, admin, 'timed');
    const res = await prepare(compact);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const d = body.deskCode as string;
    expect(body.filename).toBe(`IndiansAssist-in-mum-${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}.zip`);
    expect(body.sha256).toBe(sha256Hex(DIST));
    const path = new URL(body.url).pathname;

    const head = await t.app.inject({ method: 'HEAD', url: path });
    expect(head.statusCode).toBe(200);
    const g1 = await t.app.inject({ method: 'GET', url: path });
    expect(g1.statusCode).toBe(200);
    const zip = g1.rawPayload;
    expect(g1.headers['content-type']).toBe('application/zip');
    expect(g1.headers['content-disposition']).toBe(`attachment; filename="${body.filename}"`);
    expect(g1.headers['content-length']).toBe(String(zip.length));
    expect(head.headers['content-length']).toBe(String(zip.length));

    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([...BUNDLE.map(([n]) => n), MACOS_SIDECAR_NAME]);
    expect(entries[1]!.data.equals(EXE)).toBe(true);
    const cfg = await verifyIaconfig(entries[2]!.data.toString('utf8'), [publicKeyEntry(t.ctx.keys.pub)]);
    expect(cfg).not.toBeNull();
    expect(cfg!.code).toBe(d);
    expect(cfg!.region).toBe('in-mum');
    expect(cfg!.apiOrigin).toBe(t.ctx.config.apiOrigin);

    // The same grant serves the same bytes, so a range of it is a slice of the whole.
    const g2 = await t.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=100-2099' } });
    expect(g2.statusCode).toBe(206);
    expect(g2.headers['content-range']).toBe(`bytes 100-2099/${zip.length}`);
    expect(g2.rawPayload.equals(zip.subarray(100, 2100))).toBe(true);

    // unzip, where the host has it, agrees the archive is sound and the sidecar sits beside the bundle.
    const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
    if (probe.status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'ia-macos-zip-'));
      try {
        writeFileSync(join(dir, 'a.zip'), zip);
        const test = spawnSync('unzip', ['-t', join(dir, 'a.zip')], { encoding: 'utf8' });
        expect(test.status, test.stdout + test.stderr).toBe(0);
        expect(test.stdout).toContain(MACOS_SIDECAR_NAME);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('a dist zip that cannot be served answers 410 on the download, not a broken archive', async () => {
    writeDist();
    const dir = t.ctx.config.agent.distDir;
    const bad = storedZip([['Other.app/x', EXE]]);
    writeFileSync(join(dir, 'IndiansAssist-macos-arm64-0.5.0.app.zip'), bad);
    const builds = [
      {
        platform: 'macos',
        arch: 'arm64',
        version: '0.5.0',
        size: 1,
        sha256: sha256Hex(bad),
        signed: false,
        minOs: '13.0',
      },
    ];
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, builds }));
    t.ctx.agentDist.load();
    const { compact } = await p3Token(t, admin, 'timed');
    const res = await prepare(compact);
    expect(res.statusCode).toBe(201);
    const g = await t.app.inject({ method: 'GET', url: new URL(res.json().url).pathname });
    expect(g.statusCode).toBe(410);
    expect(g.json().error.code).toBe('link_expired');
  });
});
