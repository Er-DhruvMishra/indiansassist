/**
 * The public downloads routes: the list built from what the two dists loaded, streaming with Range and HEAD, the
 * hardening headers, the packaged extension under `AGENT_DIST_DIR/extension/`, the generic Linux archive, unknown files
 * and traversal attempts, a node with nothing to serve, and the per-IP limit.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import { sha256Hex } from '@indiansassist/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

let t: TestApp;
const EXE = Buffer.from('MZ fake portable agent '.repeat(40));
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(1400, 7)]);
const PORTAL = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(900, 9)]);
const MSI = Buffer.from('fake msi'.repeat(30));
const DEB = Buffer.from('fake deb'.repeat(30));
const ZIP = Buffer.from('PK fake extension'.repeat(30));

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });
const head = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'HEAD', url, headers });

function write(path: string, data: Buffer | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function publish() {
  const dist = t.ctx.config.agent.distDir;
  const msi = t.ctx.config.fleet.msiDistDir;
  write(join(dist, 'IndiansAssist-windows-x64-0.3.1.exe'), EXE);
  write(join(dist, 'IndiansAssist-linux-x64-0.3.1'), ELF);
  write(join(dist, 'IndiansAssist-linux-portal-x64-0.3.1'), PORTAL);
  const portalInfo = { sha256: sha256Hex(PORTAL), size: PORTAL.length };
  write(
    join(dist, 'manifest.json'),
    JSON.stringify({
      v: 1,
      builds: [
        { platform: 'windows', arch: 'x64', version: '0.3.1', size: EXE.length, sha256: sha256Hex(EXE), signed: true, minOs: '10.0.17763' },
        { platform: 'windows', arch: 'arm64', version: '0.3.1', size: 1, sha256: sha256Hex(EXE), signed: false, minOs: '10.0.17763' },
        { platform: 'linux', arch: 'x64', version: '0.3.1', size: ELF.length, sha256: sha256Hex(ELF), signed: true, minOs: 'glibc 2.34', companion: portalInfo },
      ],
    }),
  );
  write(join(dist, 'extension', 'IndiansAssist-extension-0.2.0.zip'), ZIP);
  write(join(dist, 'extension', 'manifest.json'), JSON.stringify({ v: 1, builds: [{ version: '0.2.0', size: ZIP.length, sha256: sha256Hex(ZIP), minOs: 'Chrome or Edge 120 or later' }] }));
  write(join(msi, 'IndiansAssist-Agent-0.3.1-windows-x64.msi'), MSI);
  write(join(msi, 'manifest.json'), JSON.stringify({ v: 1, builds: [{ arch: 'x64', version: '0.3.1', size: MSI.length, sha256: sha256Hex(MSI), signed: true, minOs: '10.0.17763' }] }));
  write(join(msi, 'linux', 'IndiansAssist-Agent-0.3.1-linux-x64.deb'), DEB);
  write(
    join(msi, 'linux', 'manifest.json'),
    JSON.stringify({ v: 1, builds: [{ platform: 'linux', format: 'deb', arch: 'x64', version: '0.3.1', size: DEB.length, sha256: sha256Hex(DEB), signed: false, minOs: 'glibc 2.34' }] }),
  );
  t.ctx.agentDist.load();
  t.ctx.installerDist.load();
}

function unpublish() {
  rmSync(t.ctx.config.agent.distDir, { recursive: true, force: true });
  rmSync(t.ctx.config.fleet.msiDistDir, { recursive: true, force: true });
  t.ctx.agentDist.load();
  t.ctx.installerDist.load();
}

beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => unpublish());

describe('GET /api/v1/downloads', () => {
  it('serves nothing when nothing is published, without a login', async () => {
    const r = await get('/api/v1/downloads');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ v: 1, files: [] });
    expect(r.headers['cache-control']).toContain('public');
  });

  it('lists every published file with its tier, platform, format and url; a row with no file on disk is left out', async () => {
    publish();
    const r = await get('/api/v1/downloads');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    const byName = Object.fromEntries(body.files.map((f: { filename: string }) => [f.filename, f]));
    expect(Object.keys(byName).sort()).toEqual([
      'IndiansAssist-Agent-0.3.1-linux-x64.deb',
      'IndiansAssist-Agent-0.3.1-windows-x64.msi',
      'IndiansAssist-extension-0.2.0.zip',
      'IndiansAssist-linux-x64-0.3.1.tar.gz',
      'IndiansAssist-windows-x64-0.3.1.exe',
    ]);
    expect(byName['IndiansAssist-windows-x64-0.3.1.exe']).toMatchObject({
      tier: 'p3_portable',
      platform: 'windows',
      arch: 'x64',
      format: 'exe',
      version: '0.3.1',
      size: EXE.length,
      sha256: sha256Hex(EXE),
      signed: true,
      url: 'http://localhost:4000/api/v1/downloads/IndiansAssist-windows-x64-0.3.1.exe',
    });
    expect(byName['IndiansAssist-Agent-0.3.1-windows-x64.msi']).toMatchObject({ tier: 'p4_installed', platform: 'windows', format: 'msi', signed: true });
    expect(byName['IndiansAssist-Agent-0.3.1-linux-x64.deb']).toMatchObject({ tier: 'p4_installed', platform: 'linux', format: 'deb', signed: false });
    expect(byName['IndiansAssist-extension-0.2.0.zip']).toMatchObject({ tier: 'p2_extension', platform: 'browser', arch: 'universal', format: 'zip', signed: false });
  });

  it('the Linux portable row is the archive of both programs; its sha256 is of the archive and it is never marked signed', async () => {
    publish();
    const row = (await get('/api/v1/downloads')).json().files.find((f: { format: string }) => f.format === 'tar.gz');
    expect(row).toMatchObject({ tier: 'p3_portable', platform: 'linux', signed: false });
    const g = await get(new URL(row.url).pathname);
    expect(g.statusCode).toBe(200);
    expect(g.headers['content-type']).toBe('application/gzip');
    expect(sha256Hex(g.rawPayload)).toBe(row.sha256);
    expect(g.rawPayload.length).toBe(row.size);
    const tar = zlib.gunzipSync(g.rawPayload);
    // The generic inner name carries no code, and the companion sits beside it as `.ia-portal`.
    expect(tar.subarray(0, 100).toString('ascii').replace(/\0+$/, '')).toBe('IndiansAssist-linux-x64-0.3.1');
    expect(tar.includes(Buffer.from('.ia-portal\0'))).toBe(true);
  });

  it('the extension zip is optional: a broken extension manifest serves no extension but the agents still load', async () => {
    publish();
    write(join(t.ctx.config.agent.distDir, 'extension', 'manifest.json'), '{ not json');
    t.ctx.agentDist.load();
    expect(t.ctx.agentDist.extensionError).toContain('invalid');
    const names = (await get('/api/v1/downloads')).json().files.map((f: { filename: string }) => f.filename);
    expect(names).not.toContain('IndiansAssist-extension-0.2.0.zip');
    expect(names).toContain('IndiansAssist-windows-x64-0.3.1.exe');
  });
});

describe('GET and HEAD /api/v1/downloads/:file', () => {
  const name = 'IndiansAssist-windows-x64-0.3.1.exe';
  const path = `/api/v1/downloads/${name}`;

  it('streams the file with the hardening headers', async () => {
    publish();
    const r = await get(path);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(EXE)).toBe(true);
    expect(r.headers['content-type']).toBe('application/vnd.microsoft.portable-executable');
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${name}"`);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-length']).toBe(String(EXE.length));
  });

  it('HEAD is free of a body and states the length', async () => {
    publish();
    const r = await head(path);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(0);
    expect(r.headers['content-length']).toBe(String(EXE.length));
  });

  it('honours Range, including a suffix range, and refuses a bad one with 416', async () => {
    publish();
    const a = await get(path, { range: 'bytes=10-19' });
    expect(a.statusCode).toBe(206);
    expect(a.rawPayload.equals(EXE.subarray(10, 20))).toBe(true);
    expect(a.headers['content-range']).toBe(`bytes 10-19/${EXE.length}`);
    expect(a.headers['content-length']).toBe('10');
    const b = await get(path, { range: 'bytes=-5' });
    expect(b.statusCode).toBe(206);
    expect(b.rawPayload.equals(EXE.subarray(EXE.length - 5))).toBe(true);
    const c = await get(path, { range: `bytes=${EXE.length + 10}-` });
    expect(c.statusCode).toBe(416);
    expect(c.headers['content-range']).toBe(`bytes */${EXE.length}`);
  });

  it('a Linux archive honours Range too', async () => {
    publish();
    const archive = (await get('/api/v1/downloads/IndiansAssist-linux-x64-0.3.1.tar.gz')).rawPayload;
    const part = await get('/api/v1/downloads/IndiansAssist-linux-x64-0.3.1.tar.gz', { range: 'bytes=40-' });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.equals(archive.subarray(40))).toBe(true);
  });

  it('an unknown name is 404; nothing outside the known files is reachable', async () => {
    publish();
    write(join(t.ctx.config.agent.distDir, 'secret.txt'), 'nope');
    const attempts = [
      '/api/v1/downloads/secret.txt',
      '/api/v1/downloads/manifest.json',
      '/api/v1/downloads/manifest.signed.json',
      '/api/v1/downloads/..%2Fmanifest.json',
      '/api/v1/downloads/%2e%2e%2fsecret.txt',
      '/api/v1/downloads/..%5Csecret.txt',
      '/api/v1/downloads/foo%2Fbar',
      '/api/v1/downloads/IndiansAssist-linux-portal-x64-0.3.1',
      '/api/v1/downloads/IndiansAssist-linux-x64-0.3.1',
    ];
    for (const url of attempts) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.rawPayload.toString(), url).not.toContain('nope');
    }
  });

  it('serves nothing when nothing is published', async () => {
    const r = await get(path);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });

  it('a reload swaps the map: a removed file stops being served and a new one appears', async () => {
    publish();
    expect((await get(path)).statusCode).toBe(200);
    unpublish();
    expect((await get(path)).statusCode).toBe(404);
  });
});

describe('the per-IP limit', () => {
  it('stops one IP after 60 file requests a minute, and the list route has its own budget', async () => {
    const limited = await makeApp({ RATE_LIMIT_DISABLED: 'false' });
    try {
      const dist = limited.ctx.config.agent.distDir;
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'IndiansAssist-windows-x64-0.3.1.exe'), EXE);
      writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ v: 1, builds: [{ platform: 'windows', arch: 'x64', version: '0.3.1', size: EXE.length, sha256: sha256Hex(EXE), signed: false, minOs: '10.0.17763' }] }));
      limited.ctx.agentDist.load();
      const url = '/api/v1/downloads/IndiansAssist-windows-x64-0.3.1.exe';
      for (let i = 0; i < 60; i++) expect((await limited.app.inject({ method: 'HEAD', url })).statusCode).toBe(200);
      const over = await limited.app.inject({ method: 'HEAD', url });
      expect(over.statusCode).toBe(429);
      expect((await limited.app.inject({ method: 'GET', url: '/api/v1/downloads' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
