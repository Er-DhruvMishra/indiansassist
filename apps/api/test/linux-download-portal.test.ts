/**
 * Phase F section 9.5 (stream wayland): the single Linux download carries the Wayland portal companion. With
 * `IndiansAssist-linux-portal-x64-<v>` in `AGENT_DIST_DIR` the archive is four gzip members (the per-download header,
 * the X11 ELF, the fixed `.ia-portal` header, the portal ELF with the end blocks); without it, today's two. The manifest
 * row gains `companion { sha256, size }`, `Range` / `HEAD` keep working, a changed companion expires a grant, and
 * `download.served` says whether the companion was carried.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { agentLinuxFileName, agentPortalDistFileName, sha256Hex } from '@indiansassist/shared';
import { listAuditByOrgPaginated } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linuxArchiveBody, PORTAL_MEMBER_NAME, ustarHeader } from '../src/services/linux-archive.js';
import { call, type Account, type TestApp } from './helpers.js';
import { makeP3App, p3Admin, p3Token } from './p3-kit.js';

let t: TestApp;
let admin: Account;

function fakeElf(seed: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  for (let i = 16; i < len; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
const X11 = fakeElf(7, 1300);
const PORTAL = fakeElf(11, 2100);

beforeAll(async () => {
  t = await makeP3App();
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});

function writeDist(opts: { portal?: Buffer | null; row?: { sha256: string; size: number } }): void {
  const dir = t.ctx.config.agent.distDir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IndiansAssist-linux-x64-0.5.0'), X11);
  if (opts.portal) writeFileSync(join(dir, agentPortalDistFileName('0.5.0')), opts.portal);
  const build = {
    platform: 'linux',
    arch: 'x64',
    version: '0.5.0',
    size: X11.length,
    sha256: sha256Hex(X11),
    signed: false,
    minOs: 'glibc 2.35',
    ...(opts.row ? { companion: opts.row } : {}),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, builds: [build] }));
  t.ctx.agentDist.load();
}

async function prepare(code: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/download/prepare',
    remoteAddress: '127.0.0.1',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'IndiansAssist' },
    payload: JSON.stringify({ code, platform: 'linux', arch: 'x64' }),
  });
}
const grantPath = (u: string) => new URL(u).pathname;

type Entry = { name: string; mode: number; size: number; data: Buffer };
const cstr = (b: Buffer, off: number, len: number) => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? len : z).toString('ascii');
};
const num = (b: Buffer, off: number, len: number) => parseInt(cstr(b, off, len).trim() || '0', 8);

/** A minimal ustar reader: entries until the two zero blocks; throws on a bad checksum or a lone zero block. */
function readTar(buf: Buffer): { entries: Entry[]; zeros: number; rest: number } {
  const entries: Entry[] = [];
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
    const size = num(h, 124, 12);
    entries.push({ name: cstr(h, 0, 100), mode: num(h, 100, 8), size, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, zeros, rest: buf.length - off };
}

function memberCount(buf: Buffer): number {
  let off = 0;
  let n = 0;
  while (off < buf.length) {
    const { engine } = zlib.inflateRawSync(buf.subarray(off + 10), { info: true }) as unknown as { engine: { bytesWritten: number } };
    off += 10 + engine.bytesWritten + 8;
    n++;
  }
  return n;
}

describe('linux-archive with the portal companion (pure)', () => {
  it('members 2-4: the X11 ELF padded without end blocks, the fixed .ia-portal header, the portal ELF with them', () => {
    const body = linuxArchiveBody(X11, PORTAL);
    expect(PORTAL_MEMBER_NAME).toBe('.ia-portal');
    expect(zlib.gunzipSync(body.member).length).toBe(1536);
    expect(body.companion!.size).toBe(PORTAL.length);
    expect(zlib.gunzipSync(body.companion!.head).equals(ustarHeader('.ia-portal', PORTAL.length))).toBe(true);
    const tail = zlib.gunzipSync(body.companion!.member);
    expect(tail.length).toBe(2560 + 1024);
    expect(tail.subarray(0, PORTAL.length).equals(PORTAL)).toBe(true);
    // Without a companion, the body is today's member with the end blocks.
    expect(zlib.gunzipSync(linuxArchiveBody(X11).member).length).toBe(1536 + 1024);
    expect(linuxArchiveBody(X11).companion).toBeUndefined();
  });
});

describe('the Linux download with the portal companion (Phase F section 9.5)', () => {
  it('manifest row carries the companion sha256 and size from the file', async () => {
    writeDist({ portal: PORTAL });
    const m = (await call(t.app, '/api/v1/download/manifest')).json();
    expect(m.builds[0]).toEqual({
      platform: 'linux',
      arch: 'x64',
      version: '0.5.0',
      size: X11.length,
      sha256: sha256Hex(X11),
      signed: false,
      minOs: 'glibc 2.35',
      companion: { sha256: sha256Hex(PORTAL), size: PORTAL.length },
    });
  });

  it('serves four members that extract as the per-download X11 binary and .ia-portal, with Range, HEAD and the audit flag', async () => {
    writeDist({ portal: PORTAL, row: { sha256: sha256Hex(PORTAL), size: PORTAL.length } });
    const { compact, token } = await p3Token(t, admin, 'timed');
    const res = await prepare(compact);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sha256).toBe(sha256Hex(X11));
    const inner = agentLinuxFileName('in-mum', body.deskCode);
    const path = grantPath(body.url);
    const head = await t.app.inject({ method: 'HEAD', url: path });
    const g = await t.app.inject({ method: 'GET', url: path });
    expect(g.statusCode).toBe(200);
    const archive = g.rawPayload;
    expect(head.headers['content-length']).toBe(String(archive.length));
    expect(g.headers['content-type']).toBe('application/gzip');
    expect(memberCount(archive)).toBe(4);
    const tar = readTar(zlib.gunzipSync(archive));
    expect(tar.entries.map((e) => [e.name, e.mode, e.size])).toEqual([
      [inner, 0o755, X11.length],
      ['.ia-portal', 0o755, PORTAL.length],
    ]);
    expect(tar.entries[0]!.data.equals(X11)).toBe(true);
    expect(tar.entries[1]!.data.equals(PORTAL)).toBe(true);
    expect(tar.zeros).toBe(2);
    expect(tar.rest).toBe(0);
    const g2 = await t.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=200-' } });
    expect(g2.statusCode).toBe(206);
    expect(Buffer.concat([archive.subarray(0, 200), g2.rawPayload]).equals(archive)).toBe(true);
    const served = (await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'download.served', limit: 200 })).items;
    const mine = served.filter((e) => (e.data as { tokenId: string }).tokenId === token.id);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.data as { companion?: boolean }).companion).toBe(true);
  });

  it('without the companion file the archive is the two-member one and the audit says companion false', async () => {
    writeDist({ portal: null });
    const m = (await call(t.app, '/api/v1/download/manifest')).json();
    expect(m.builds[0].companion).toBeUndefined();
    const { compact, token } = await p3Token(t, admin, 'timed');
    const body = (await prepare(compact)).json();
    const archive = (await t.app.inject({ method: 'GET', url: grantPath(body.url) })).rawPayload;
    expect(memberCount(archive)).toBe(2);
    expect(readTar(zlib.gunzipSync(archive)).entries).toHaveLength(1);
    const served = (await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'download.served', limit: 200 })).items;
    const mine = served.filter((e) => (e.data as { tokenId: string }).tokenId === token.id);
    expect((mine[0]!.data as { companion?: boolean }).companion).toBe(false);
  });

  it('a companion that does not match its manifest row is left out; a changed companion expires a grant', async () => {
    writeDist({ portal: PORTAL, row: { sha256: sha256Hex(X11), size: 5 } });
    expect((await call(t.app, '/api/v1/download/manifest')).json().builds[0].companion).toBeUndefined();
    expect(t.ctx.agentDist.lastError).toContain('does not match');
    writeDist({ portal: PORTAL });
    const body = (await prepare((await p3Token(t, admin, 'timed')).compact)).json();
    writeDist({ portal: fakeElf(12, 900) });
    const r = await t.app.inject({ method: 'GET', url: grantPath(body.url) });
    expect(r.statusCode).toBe(410);
    expect(r.json().error.code).toBe('link_expired');
  });
});
