/**
 * Phase C section 2.2: manifest, prepare (lookup, desk code, grant), the grant budget (3 GETs, HEAD free), the
 * same-IP rule, Range, cross-region refusal, one `download.served` per grant, desk-code lookups and retirement.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidShortCode, parseAgentFileName, sha256Hex } from '@indiansassist/shared';
import { listAuditByOrgPaginated } from '@indiansassist/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { call, createToken, listen, type Account, type TestApp } from './helpers.js';
import { makeP3App, P3Kit, p3Admin, p3Token } from './p3-kit.js';

let t: TestApp;
let url: string;
let admin: Account;
const kits: P3Kit[] = [];
const BYTES = Buffer.from('MZ fake agent build for tests '.repeat(40));

beforeAll(async () => {
  t = await makeP3App();
  url = await listen(t.app);
  admin = await p3Admin(t);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  for (const k of kits.splice(0)) k.closeAll();
});

function writeDist(): void {
  const dir = t.ctx.config.agent.distDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'IndiansAssist-windows-x64-0.3.0.exe'), BYTES);
  const build = (arch: string) => ({ platform: 'windows', arch, version: '0.3.0', size: 1, sha256: sha256Hex(BYTES), signed: false, minOs: '10.0.17763' });
  // arm64 is listed but its file is missing: it must not be served.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ v: 1, builds: [build('x64'), build('arm64')] }));
  t.ctx.agentDist.load();
}

async function prepare(code: string, over: Record<string, unknown> = {}, ip = '127.0.0.1') {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/download/prepare',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'IndiansAssist' },
    payload: JSON.stringify({ code, platform: 'windows', arch: 'x64', ...over }),
  });
}

function grantPath(u: string): string {
  return new URL(u).pathname;
}

describe('download flow', () => {
  it('without a dist dir: empty manifest and 503 on prepare', async () => {
    const m = await call(t.app, '/api/v1/download/manifest');
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ v: 1, builds: [] });
    const { compact } = await p3Token(t, admin);
    expect((await prepare(compact)).json().error.code).toBe('download_unavailable');
  });

  it('manifest lists served builds only; prepare checks tier and arch', async () => {
    writeDist();
    const m = await call(t.app, '/api/v1/download/manifest');
    expect(m.headers['cache-control']).toContain('max-age=300');
    expect(m.json().builds.map((b: { arch: string }) => b.arch)).toEqual(['x64']);
    const p1 = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'one_time' });
    expect((await prepare(p1.compact)).json().error.code).toBe('invalid_token_type');
    const { compact } = await p3Token(t, admin);
    expect((await prepare(compact, { arch: 'arm64' })).json().error.code).toBe('download_unavailable');
    expect((await prepare(compact, { arch: 'universal' })).statusCode).toBe(400);
    expect((await prepare('123456789012')).json().error.code).toBe('token_not_found');
  });

  it('grant: filename with region + desk code, 3 GETs, HEAD free, Range, same IP, one download.served', async () => {
    const { compact, token } = await p3Token(t, admin, 'timed');
    const res = await prepare(compact);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const parsed = parseAgentFileName(body.filename);
    expect(parsed?.region).toBe('in-mum');
    expect(parsed?.deskCode).toBe(body.deskCode);
    expect(isValidShortCode(body.deskCode)).toBe(true);
    expect(body.deskCode).not.toBe(token.shortCode);
    expect(body.sha256).toBe(sha256Hex(BYTES));
    const path = grantPath(body.url);
    const head = await t.app.inject({ method: 'HEAD', url: path });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(BYTES.length));
    const g1 = await t.app.inject({ method: 'GET', url: path });
    expect(g1.statusCode).toBe(200);
    expect(g1.rawPayload.equals(BYTES)).toBe(true);
    expect(g1.headers['content-disposition']).toBe(`attachment; filename="${body.filename}"`);
    expect(g1.headers['x-content-type-options']).toBe('nosniff');
    expect(g1.headers['content-security-policy']).toContain('sandbox');
    expect(g1.headers['cache-control']).toBe('private, no-store');
    expect(g1.headers['content-type']).toBe('application/vnd.microsoft.portable-executable');
    const other = await t.app.inject({ method: 'GET', url: path, remoteAddress: '10.9.9.9' });
    expect(other.json().error.code).toBe('link_expired');
    const g2 = await t.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-15' } });
    expect(g2.statusCode).toBe(206);
    expect(g2.headers['content-range']).toBe(`bytes 0-15/${BYTES.length}`);
    expect(g2.rawPayload.equals(BYTES.subarray(0, 16))).toBe(true);
    const bad = await t.app.inject({ method: 'HEAD', url: path, headers: { range: `bytes=${BYTES.length}-` } });
    expect(bad.statusCode).toBe(416);
    expect((await t.app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    const g4 = await t.app.inject({ method: 'GET', url: path });
    expect(g4.statusCode).toBe(410);
    expect(g4.json().error.code).toBe('link_expired');
    const served = (await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'download.served', limit: 200 })).items;
    expect(served.filter((e) => (e.data as { tokenId: string }).tokenId === token.id)).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/download/' + 'A'.repeat(43) })).statusCode).toBe(410);
  });

  it('a grant of a region this node does not serve is 410', async () => {
    const { compact } = await p3Token(t, admin, 'timed');
    const body = (await prepare(compact)).json();
    const grant = grantPath(body.url).split('/').pop()!;
    const key = `ia:dl:${sha256Hex(grant)}`;
    const entry = JSON.parse((await t.ctx.presence.getKey(key))!);
    await t.ctx.presence.setKey(key, JSON.stringify({ ...entry, region: 'eu-fra' }), 120);
    const saved = t.ctx.config.servedRegions;
    t.ctx.config.servedRegions = ['in-mum'];
    try {
      expect((await t.app.inject({ method: 'GET', url: grantPath(body.url) })).statusCode).toBe(410);
    } finally {
      t.ctx.config.servedRegions = saved;
    }
  });

  it('desk code: Origin-less lookup only, native hello, retired at first active; one_time used => token_used', async () => {
    const kit = new P3Kit(t, url);
    kits.push(kit);
    const { compact } = await p3Token(t, admin);
    const { deskCode } = (await prepare(compact)).json();
    const native = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: deskCode } });
    expect(native.statusCode).toBe(200);
    expect(native.json().agent.windows.x64).toBe(true);
    const browser = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: deskCode }, headers: { origin: 'http://localhost:5173' } });
    expect(browser.json().error.code).toBe('token_not_found');
    const assist = await kit.assist(admin);
    const desk = await kit.nativeDesk(deskCode);
    const knock = await desk.request({ t: 'desk.knock' }, 'knock.ok');
    const sessionId = knock.sessionId as string;
    await assist.next('assist.knock', (m) => m.sessionId === sessionId);
    await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
    await desk.next('session.created');
    const ok = await desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'view', monitors: [1], clipboard: false } }, 'consent.ok');
    expect(ok.state).toBe('active');
    const after = await call(t.app, '/api/v1/tokens/public-lookup', { body: { code: deskCode } });
    expect(after.statusCode).toBe(404);
    expect((await prepare(compact)).json().error.code).toBe('token_used');
  });
});
