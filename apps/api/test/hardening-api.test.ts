/** Regression tests for the second REST pass: SEC-01 media allow-list, SEC-07 credential routes, SEC-08 abandoned
 * uploads, SEC-11 compensated short-code budgets. */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  getOrg,
  getRecordingBySession,
  getSession,
  getUser,
  listAuditBySession,
  recording as recordingTable,
  seedSession,
  seedToken,
  transitionSession,
} from '@indiansassist/db';
import { generateShortCode, recordingMediaType, RECORDING_MIME_RE } from '@indiansassist/shared';
import { ShortCodeBudget } from '../src/limiter.js';
import { CREDENTIAL_ROUTE_RE, loggerOptions, serializeErrorWithoutMessages } from '../src/lib/logger.js';
import { registerErrorHandlers } from '../src/plugins/errors.js';
import { prepareRecording } from '../src/services/recording-service.js';
import { Sweeper } from '../src/sweeper.js';
import { call, makeApp, signup, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;

beforeAll(async () => {
  t = await makeApp({ USER_MAX_OPEN_UPLOADS: '1', RECORDING_DOWNLOAD_ORIGIN: 'https://dl.example.test' });
  admin = await signup(t.app);
});
afterAll(async () => {
  await t.close();
});

async function activeSession(acc: Account): Promise<string> {
  const org = (await getOrg(t.db, acc.org.id))!;
  const user = (await getUser(t.db, acc.user.id))!;
  const s = await seedSession(t.db, await seedToken(t.db, org, user), { assistUserId: user.id });
  await transitionSession(t.db, s.id, 'accepted', { set: { assistUserId: user.id } });
  await transitionSession(t.db, s.id, 'consent_pending');
  await transitionSession(t.db, s.id, 'active', { set: { consentSurface: 'monitor' } });
  return s.id;
}

function upload(acc: Account, sid: string, file: Buffer, mime: string) {
  const b = `----ia${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify({ mime })}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="r"\r\nContent-Type: ${mime}\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return call(t.app, `/api/v1/sessions/${sid}/recordings`, {
    cookie: acc.cookie,
    body,
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  });
}

describe('SEC-01 media allow-list and download isolation', () => {
  it('accepts exactly the four media types, with or without a (quoted) codecs parameter', () => {
    for (const ok of ['video/webm', 'video/webm;codecs=vp9,opus', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'audio/webm;codecs=opus', 'audio/ogg'])
      expect(RECORDING_MIME_RE.test(ok)).toBe(true);
    for (const bad of ['text/html', 'image/svg+xml', 'application/javascript', 'video/webm;charset=utf-8', 'video/webm\ntext/html', 'VIDEO/WEBM', 'video/mp4;codecs=<x>'])
      expect(RECORDING_MIME_RE.test(bad)).toBe(false);
    expect(recordingMediaType('video/mp4; codecs="avc1"')).toBe('video/mp4');
    expect(recordingMediaType('text/html')).toBeNull();
  });

  it('serves an mp4 recording as a sandboxed video/mp4 attachment from RECORDING_DOWNLOAD_ORIGIN', async () => {
    const sid = await activeSession(admin);
    const res = await upload(admin, sid, randomBytes(128), 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const dl = (await call(t.app, `/api/v1/recordings/${id}/download`, { cookie: admin.cookie })).json();
    const url = new URL(dl.url as string);
    expect(url.origin).toBe('https://dl.example.test');
    const file = await call(t.app, url.pathname + url.search);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('video/mp4');
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${id}.mp4"`);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(file.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('never reflects a stored mime that is not on the list (row written before the allow-list)', async () => {
    const sid = await activeSession(admin);
    const res = await upload(admin, sid, Buffer.from('<script>alert(1)</script>'), 'video/webm');
    const id = res.json().id as string;
    await t.db.update(recordingTable).set({ mime: 'text/html' }).where(eq(recordingTable.id, id));
    const dl = (await call(t.app, `/api/v1/recordings/${id}/download`, { cookie: admin.cookie })).json();
    const url = new URL(dl.url as string);
    const file = await call(t.app, url.pathname + url.search);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['content-disposition']).toBe(`attachment; filename="${id}.bin"`);
  });
});

describe('SEC-08 abandoned single uploads', () => {
  it('the sweeper fails an upload left `uploading` past its expiry and frees the open-upload quota', async () => {
    const a = await activeSession(admin);
    const b = await activeSession(admin);
    const init = await call(t.app, `/api/v1/sessions/${a}/recordings/uploads`, { cookie: admin.cookie, body: { mime: 'video/webm', bytes: 10 } });
    expect(init.statusCode).toBe(201);
    // USER_MAX_OPEN_UPLOADS=1: a second open upload is refused.
    expect((await upload(admin, b, randomBytes(16), 'video/webm')).statusCode).toBe(429);
    const rec = (await getRecordingBySession(t.db, a))!;
    await t.db.update(recordingTable).set({ uploadExpiresAt: new Date(Date.now() - 1000) }).where(eq(recordingTable.id, rec.id));
    await new Sweeper(t.ctx).runOnce();
    expect((await getRecordingBySession(t.db, a))?.status).toBe('failed');
    const actions = (await listAuditBySession(t.db, a)).map((e) => [e.action, e.data['error']]);
    expect(actions).toContainEqual(['recording.failed', 'upload_expired']);
    expect((await upload(admin, b, randomBytes(16), 'video/webm')).statusCode).toBe(201);
  });

  it('a single upload row carries a 1 h abandonment expiry while open', async () => {
    const sid = await activeSession(admin);
    const rec = await prepareRecording(t.ctx, (await getSession(t.db, sid))!, admin.user.id, { mime: 'video/webm' });
    const left = rec.uploadExpiresAt!.getTime() - Date.now();
    expect(left).toBeGreaterThan(59 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
  });
});

describe('SEC-07 credential routes', () => {
  it('logs a 5xx on an auth route without any message, and redacts bodies', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const opts = loggerOptions('info') as Record<string, unknown>;
    const app = Fastify({ logger: { ...opts, stream } });
    registerErrorHandlers(app);
    app.post('/api/v1/auth/login', async () => {
      throw new SyntaxError('Unexpected token in JSON: {"password":"hunter2-secret"}');
    });
    app.post('/api/v1/sessions/x', async (req) => {
      req.log.info({ body: { password: 'body-secret' } }, 'someone logged a body');
      throw new Error('plain failure');
    });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'hunter2-secret' } });
    expect(r.statusCode).toBe(500);
    await app.inject({ method: 'POST', url: '/api/v1/sessions/x', payload: {} });
    await app.close();
    const text = lines.join('');
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('body-secret');
    expect(text).toContain('message withheld');
    expect(text).toContain('plain failure'); // other routes keep their (truncated) message
  });

  it('matches only the auth and token route families', () => {
    expect(CREDENTIAL_ROUTE_RE.test('/api/v1/auth/login')).toBe(true);
    expect(CREDENTIAL_ROUTE_RE.test('/api/v1/tokens/public-lookup')).toBe(true);
    expect(CREDENTIAL_ROUTE_RE.test('/api/v1/tokensx')).toBe(false);
    expect(CREDENTIAL_ROUTE_RE.test('/api/v1/sessions')).toBe(false);
    const out = serializeErrorWithoutMessages(Object.assign(new Error('pw=1'), { cause: new Error('pw=2'), code: 'E' }));
    expect(JSON.stringify(out)).not.toMatch(/pw=/);
    expect(out.code).toBe('E');
  });
});

describe('SEC-11 compensated short-code budgets', () => {
  it('the node budget blocks after 30 misses in a minute', () => {
    let now = 0;
    let alerts = 0;
    const b = new ShortCodeBudget(() => alerts++, undefined, undefined, undefined, () => now);
    for (let i = 0; i < 30; i++) b.recordMiss();
    expect(b.blockedFor()).toBe(0);
    b.recordMiss();
    expect(b.blockedFor()).toBe(300);
    expect(alerts).toBe(1);
    now += 300_000;
    expect(b.blockedFor()).toBe(0);
  });

  it('one IP gets 3 short-code misses per minute, then 429 without a lookup', async () => {
    const limited = await makeApp({ RATE_LIMIT_DISABLED: 'false' });
    try {
      const codes = Array.from({ length: 4 }, () => generateShortCode());
      for (const code of codes.slice(0, 3)) {
        const r = await call(limited.app, '/api/v1/tokens/public-lookup', { body: { code } });
        expect(r.statusCode).toBe(404);
      }
      const fourth = await call(limited.app, '/api/v1/tokens/public-lookup', { body: { code: codes[3] } });
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json().error.code).toBe('rate_limited');
      // Another address is unaffected, and the node budget (30) is far from exhausted.
      const other = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/tokens/public-lookup',
        payload: { code: generateShortCode() },
        headers: { 'x-requested-with': 'IndiansAssist' },
        remoteAddress: '10.9.8.7',
      });
      expect(other.statusCode).toBe(404);
      expect(limited.ctx.shortCodes.blockedFor()).toBe(0);
    } finally {
      await limited.close();
    }
  });
});
