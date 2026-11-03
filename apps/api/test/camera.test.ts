/**
 * Phase F section 6 (docs/specs/phase-f-contracts.md, gate section 15.5): the phone camera's links, `/signal` side and
 * chain entries. Links: RBAC (the session's Assist only), tier and state refusals, one per session, single use, TTL,
 * revoke. Hello: a bad code closes 4403, resume within the window and not after. WebRTC routing camera <-> the
 * session's Assist only. Session end closes the camera. The code never appears in a log line. Two nodes sharing
 * presence: `camera_busy`, single use and `DELETE` on the node that does not own the session (`ia:camsess:`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, listAuditBySession, listParticipants, org as orgTable, type Db } from '@indiansassist/db';
import { eq } from 'drizzle-orm';
import { MemoryPresence } from '../src/adapters/presence.js';
import { RedisPresence } from '../src/adapters/presence-redis.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/lib/metrics.js';
import { cameraTiming } from '../src/signal/camera.js';
import { FakeRedisServer } from './fake-redis.js';
import {
  addMember,
  call,
  captureLogLines,
  listen,
  makeApp,
  makeDb,
  signup,
  SignalClient,
  TURN_SECRET,
  WEB_ORIGIN,
  type Account,
  type Msg,
  type TestApp,
} from './helpers.js';
import { licenceP2, P2Kit } from './p2-kit.js';
import { Kit, sleep } from './signal-kit.js';

let t: TestApp;
let url: string;
let admin: Account;
let kit: Kit;
const phones: SignalClient[] = [];
let logs: string[];

beforeAll(async () => {
  t = await makeApp({}, { tickMs: 50, eventGraceMs: 2_000 }, { logLevel: 'info' });
  logs = captureLogLines(t.app);
  url = await listen(t.app);
  admin = await signup(t.app);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  kit?.closeAll();
  for (const p of phones.splice(0)) p.close();
  cameraTiming.resumeMs = 60_000;
});

async function link(sessionId: string, acc: Account = admin) {
  return call(t.app, `/api/v1/sessions/${sessionId}/camera-links`, { method: 'POST', cookie: acc.cookie });
}

async function phone(u = url): Promise<SignalClient> {
  const p = await SignalClient.open(u);
  phones.push(p);
  return p;
}

async function actions(sessionId: string, db: Db = t.db): Promise<{ action: string; data: Record<string, unknown> }[]> {
  return (await listAuditBySession(db, sessionId)).map((e) => ({
    action: e.action,
    data: (e.data ?? {}) as Record<string, unknown>,
  }));
}

/** An active P1 session, a camera link and a phone that said hello (and, with `ready`, started its track). */
async function joinedCamera(opts: { ready?: boolean } = {}) {
  kit = new Kit(t, url);
  const s = await kit.activeSession(admin);
  const res = await link(s.sessionId);
  expect(res.statusCode).toBe(201);
  const body = res.json() as { cameraId: string; url: string; code: string; expiresAt: string };
  await s.assist.next('camera.state', (m) => m.state === 'linked');
  const ph = await phone();
  const ok = await ph.request({ t: 'camera.hello', code: body.code }, 'camera.hello.ok');
  if (opts.ready) {
    ph.send({ t: 'camera.ready', cameraId: body.cameraId, width: 1280, height: 720, facing: 'environment' });
    await s.assist.next('camera.state', (m) => m.state === 'live');
  }
  return { ...s, link: body, ph, ok };
}

describe('camera links (section 6.2, 6.7)', () => {
  it('creates a link for the session Assist only, with a 12-character Crockford code and the web URL', async () => {
    kit = new Kit(t, url);
    const s = await kit.activeSession(admin);
    const tech = await addMember(t.app, admin, 'technician');
    const senior = await addMember(t.app, admin, 'senior_technician');
    const auditor = await addMember(t.app, admin, 'auditor');
    const other = await signup(t.app);
    expect((await link(s.sessionId, tech)).statusCode).toBe(403);
    expect((await link(s.sessionId, senior)).statusCode).toBe(403);
    expect((await link(s.sessionId, auditor)).statusCode).toBe(403);
    expect((await link(s.sessionId, other)).statusCode).toBe(404);
    const res = await link(s.sessionId);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { cameraId: string; url: string; code: string; expiresAt: string };
    expect(body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(body.url).toBe(`${WEB_ORIGIN}/c/${body.code}`);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(await s.assist.next('camera.state')).toMatchObject({ cameraId: body.cameraId, state: 'linked' });
    // one per session (camera_busy), and the chain names the camera, never the code
    const again = await link(s.sessionId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('camera_busy');
    const entries = await actions(s.sessionId);
    const created = entries.find((e) => e.action === 'camera.link_created');
    expect(created?.data).toEqual({ cameraId: body.cameraId, expiresAt: body.expiresAt });
    expect(JSON.stringify(entries)).not.toContain(body.code);
  });

  it('refuses a session that is not live (bad_state) and a P2 session (camera_unsupported)', async () => {
    kit = new Kit(t, url);
    const s = await kit.activeSession(admin);
    expect(
      (await call(t.app, `/api/v1/sessions/${s.sessionId}/end`, { method: 'POST', cookie: admin.cookie, body: {} }))
        .statusCode,
    ).toBeLessThan(300);
    const ended = await link(s.sessionId);
    expect(ended.statusCode).toBe(409);
    expect(ended.json().error.code).toBe('bad_state');

    await licenceP2(t, admin);
    const p2 = new P2Kit(t, url);
    try {
      const a = await p2.active(admin);
      const res = await link(a.sessionId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('camera_unsupported');
    } finally {
      p2.closeAll();
    }
  });

  it('revokes a pending link (camera.link_revoked) so its code no longer works', async () => {
    kit = new Kit(t, url);
    const s = await kit.activeSession(admin);
    const body = (await link(s.sessionId)).json() as { cameraId: string; code: string };
    const del = await call(t.app, `/api/v1/sessions/${s.sessionId}/camera-links/${body.cameraId}`, {
      method: 'DELETE',
      cookie: admin.cookie,
    });
    expect(del.statusCode).toBe(204);
    expect(await s.assist.next('camera.state', (m) => m.state === 'ended')).toMatchObject({ reason: 'assist' });
    const ph = await phone();
    ph.send({ t: 'camera.hello', code: body.code });
    expect((await ph.next('error')).code).toBe('camera_link_invalid');
    expect(await ph.closed()).toBe(4403);
    expect((await actions(s.sessionId)).map((e) => e.action)).toContain('camera.link_revoked');
    // the session can link a new camera afterwards
    expect((await link(s.sessionId)).statusCode).toBe(201);
  });
});

describe('camera.hello (section 6.4)', () => {
  it('closes 4403 on a bad code', async () => {
    const ph = await phone();
    ph.send({ t: 'camera.hello', code: 'ZZZZ-ZZZZ-ZZZZ' });
    expect((await ph.next('error')).code).toBe('camera_link_invalid');
    expect(await ph.closed()).toBe(4403);
  });

  it('joins with the code (single use): names, TURN for camera:<id>, recording flags, participant row', async () => {
    const c = await joinedCamera();
    expect(c.ok).toMatchObject({
      cameraId: c.link.cameraId,
      sessionId: c.sessionId,
      technician: { name: admin.user.name },
      limits: { maxBitrateKbps: 1500 },
      recording: { server: false, console: false },
    });
    expect((c.ok.org as { displayName: string }).displayName.length).toBeGreaterThan(0);
    expect(c.ok.resumeKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(c.ok.iceServers)).toContain(`camera:${c.link.cameraId}`);
    expect(await c.assist.next('camera.state', (m) => m.state === 'joined')).toMatchObject({
      cameraId: c.link.cameraId,
    });
    expect(await c.desk.next('camera.state', (m) => m.state === 'joined')).toMatchObject({ cameraId: c.link.cameraId });
    const parts = await listParticipants(t.db, c.sessionId);
    expect(
      parts.some((p) => p.role === 'camera' && p.label === 'Phone camera' && p.userId === null && p.leftAt === null),
    ).toBe(true);
    // the code is spent
    const second = await phone();
    second.send({ t: 'camera.hello', code: c.link.code.toLowerCase() });
    expect((await second.next('error')).code).toBe('camera_link_invalid');
    // a second hello on the same socket is refused
    c.ph.send({ t: 'camera.hello', code: c.link.code });
    expect((await c.ph.next('error')).code).toBe('bad_state');
  });

  it('refuses a camera of an org whose erasure is executing (org_erasing, 4403; section 5.3 step 1)', async () => {
    const acc = await signup(t.app);
    kit = new Kit(t, url);
    const s = await kit.activeSession(acc);
    const body = (await link(s.sessionId, acc)).json() as { code: string };
    await t.db.update(orgTable).set({ erasingAt: new Date() }).where(eq(orgTable.id, acc.org.id));
    try {
      const ph = await phone();
      ph.send({ t: 'camera.hello', code: body.code });
      expect((await ph.next('error')).code).toBe('org_erasing');
      expect(await ph.closed()).toBe(4403);
      await sleep(200);
      expect(s.assist.messages.some((m) => m.t === 'camera.state' && m.state === 'joined')).toBe(false);
    } finally {
      await t.db.update(orgTable).set({ erasingAt: null }).where(eq(orgTable.id, acc.org.id));
    }
  });

  it('chains camera.started as the Desk on camera.ready, and refuses snapshots before it', async () => {
    const c = await joinedCamera();
    const early = await call(t.app, `/api/v1/sessions/${c.sessionId}/camera/${c.link.cameraId}/snapshots`, {
      cookie: admin.cookie,
      body: { sha256: 'a'.repeat(64), width: 10, height: 10 },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('bad_state');
    c.ph.send({ t: 'camera.ready', cameraId: c.link.cameraId, width: 1280, height: 720, facing: 'environment' });
    await c.assist.next('camera.state', (m) => m.state === 'live');
    const started = (await listAuditBySession(t.db, c.sessionId)).find((e) => e.action === 'camera.started');
    expect(started?.actorType).toBe('desk');
    expect(started?.data).toEqual({ cameraId: c.link.cameraId, width: 1280, height: 720, facing: 'environment' });
    const snap = await call(t.app, `/api/v1/sessions/${c.sessionId}/camera/${c.link.cameraId}/snapshots`, {
      cookie: admin.cookie,
      body: { sha256: 'b'.repeat(64), width: 1280, height: 720 },
    });
    expect(snap.statusCode).toBe(201);
    const entry = (await actions(c.sessionId)).find((e) => e.action === 'camera.snapshot');
    expect(entry?.data).toEqual({ cameraId: c.link.cameraId, sha256: 'b'.repeat(64), width: 1280, height: 720 });
  });
});

describe('webrtc routing (section 6.4)', () => {
  it('relays camera <-> the session Assist only, never into the Desk peer connection', async () => {
    const c = await joinedCamera({ ready: true });
    c.ph.send({ t: 'webrtc.offer', sessionId: c.sessionId, sdp: 'v=0 camera-offer' });
    const offer = await c.assist.next('webrtc.offer', (m) => m.peer === 'camera');
    // the console's session controllers match on sessionId: the camera's frames carry the camera id instead
    expect(offer).toMatchObject({ sessionId: c.link.cameraId, sdp: 'v=0 camera-offer', peer: 'camera' });
    c.assist.send({ t: 'webrtc.answer', sessionId: c.sessionId, sdp: 'v=0 camera-answer', peer: 'camera' });
    const answer = await c.ph.next('webrtc.answer');
    expect(answer).toMatchObject({ sessionId: c.sessionId, sdp: 'v=0 camera-answer' });
    expect(answer.peer).toBeUndefined();
    c.ph.send({ t: 'webrtc.ice', sessionId: c.sessionId, candidate: null });
    expect(await c.assist.next('webrtc.ice', (m) => m.peer === 'camera')).toMatchObject({ sessionId: c.link.cameraId });
    expect(await c.desk.quiet('webrtc.offer', 200)).toBe(true);
    // a Desk can neither speak as nor to the camera
    c.desk.send({ t: 'webrtc.offer', sessionId: c.sessionId, sdp: 'v=0 desk', peer: 'camera' });
    expect((await c.desk.next('error')).code).toBe('forbidden');
    // no recorder takes this camera
    c.ph.send({ t: 'webrtc.offer', sessionId: c.sessionId, sdp: 'v=0', peer: 'recorder' });
    expect((await c.ph.next('error')).code).toBe('consent_required');
    // another session's id is forbidden for the camera
    c.ph.send({ t: 'webrtc.offer', sessionId: '00000000-0000-4000-8000-000000000001', sdp: 'v=0' });
    expect((await c.ph.next('error')).code).toBe('forbidden');
  });
});

describe('camera end (sections 6.3, 6.4, 6.7)', () => {
  it('ends with the session: camera.closed session_ended, close 1000, camera.ended chained', async () => {
    const c = await joinedCamera({ ready: true });
    const end = await call(t.app, `/api/v1/sessions/${c.sessionId}/end`, {
      method: 'POST',
      cookie: admin.cookie,
      body: {},
    });
    expect(end.statusCode).toBeLessThan(300);
    expect(await c.ph.next('camera.closed')).toMatchObject({ reason: 'session_ended' });
    expect(await c.ph.closed()).toBe(1000);
    await sleep(100);
    const ended = (await actions(c.sessionId)).find((e) => e.action === 'camera.ended');
    expect(ended?.data).toMatchObject({ cameraId: c.link.cameraId, by: 'session_ended' });
    expect(typeof ended?.data.durationMs).toBe('number');
    const parts = await listParticipants(t.db, c.sessionId);
    expect(parts.filter((p) => p.role === 'camera').every((p) => p.leftAt !== null)).toBe(true);
  });

  it('stops when the phone stops (declined before the track, phone_stopped after)', async () => {
    const c = await joinedCamera();
    c.ph.send({ t: 'camera.stop', cameraId: c.link.cameraId, reason: 'declined' });
    expect(await c.ph.next('camera.closed')).toMatchObject({ reason: 'declined' });
    expect(await c.assist.next('camera.state', (m) => m.state === 'ended')).toMatchObject({ reason: 'declined' });
    expect((await actions(c.sessionId)).find((e) => e.action === 'camera.ended')?.data).toMatchObject({
      by: 'declined',
      durationMs: null,
    });
    // a new link is possible right away
    expect((await link(c.sessionId)).statusCode).toBe(201);
  });

  it('DELETE ends a connected camera (camera.ended by assist)', async () => {
    const c = await joinedCamera({ ready: true });
    const del = await call(t.app, `/api/v1/sessions/${c.sessionId}/camera-links/${c.link.cameraId}`, {
      method: 'DELETE',
      cookie: admin.cookie,
    });
    expect(del.statusCode).toBe(204);
    expect(await c.ph.next('camera.closed')).toMatchObject({ reason: 'assist' });
    const list = await actions(c.sessionId);
    expect(list.find((e) => e.action === 'camera.ended')?.data).toMatchObject({ by: 'assist' });
    expect(list.map((e) => e.action)).not.toContain('camera.link_revoked');
  });

  it('keeps a dropped phone for the resume window, then ends it as disconnected', async () => {
    cameraTiming.resumeMs = 600;
    const c = await joinedCamera({ ready: true });
    c.ph.close();
    await sleep(200);
    const back = await phone();
    const ok = await back.request({ t: 'camera.hello', resumeKey: c.ok.resumeKey }, 'camera.hello.ok');
    expect(ok.cameraId).toBe(c.link.cameraId);
    expect(ok.resumeKey).not.toBe(c.ok.resumeKey);
    // the old key is spent by the resume
    const stale = await phone();
    stale.send({ t: 'camera.hello', resumeKey: c.ok.resumeKey });
    expect((await stale.next('error')).code).toBe('camera_link_invalid');
    // drop again and wait past the window: the camera ends `disconnected`, the key no longer resumes
    back.close();
    await c.assist.next('camera.state', (m) => m.state === 'ended' && m.reason === 'disconnected', 3000);
    const late = await phone();
    late.send({ t: 'camera.hello', resumeKey: ok.resumeKey });
    expect((await late.next('error')).code).toBe('camera_link_invalid');
  });

  it('never writes the camera code into a log line', async () => {
    const c = await joinedCamera({ ready: true });
    await call(t.app, `/api/v1/sessions/${c.sessionId}/camera-links/${c.link.cameraId}`, {
      method: 'DELETE',
      cookie: admin.cookie,
    });
    const bad = await phone();
    bad.send({ t: 'camera.hello', code: c.link.code });
    await bad.closed();
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(c.link.code);
    expect(all.toLowerCase()).not.toContain(c.link.code.toLowerCase());
  });
});

describe('link TTL (section 6.2b)', () => {
  it('a code is refused after LIMITS.cameraLinkTtlSec', async () => {
    let now = Date.now();
    const presence = new MemoryPresence('test-node', () => now);
    const t2 = await makeApp({}, { tickMs: 50 }, { presence });
    try {
      const u2 = await listen(t2.app);
      const acc = await signup(t2.app);
      const k = new Kit(t2, u2);
      try {
        const s = await k.activeSession(acc);
        const body = (
          await call(t2.app, `/api/v1/sessions/${s.sessionId}/camera-links`, { method: 'POST', cookie: acc.cookie })
        ).json() as { code: string };
        now += 601_000;
        const ph = await phone(u2);
        ph.send({ t: 'camera.hello', code: body.code });
        expect((await ph.next('error')).code).toBe('camera_link_invalid');
        // the busy record expired with it
        expect(
          (await call(t2.app, `/api/v1/sessions/${s.sessionId}/camera-links`, { method: 'POST', cookie: acc.cookie }))
            .statusCode,
        ).toBe(201);
      } finally {
        k.closeAll();
      }
    } finally {
      await t2.close();
    }
  });
});

describe('two nodes sharing presence (section 6.2c)', () => {
  type Node = TestApp & { url: string };
  let db: Db;
  let srv: FakeRedisServer;
  let A: Node;
  let B: Node;

  async function startNode(nodeId: string): Promise<Node> {
    const storageDir = mkdtempSync(join(tmpdir(), 'ia-api-cam-'));
    const config = loadConfig(
      {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_DISABLED: 'true',
        NODE_ID: nodeId,
        WEB_ORIGIN,
        API_ORIGIN: 'http://localhost:4150',
        STORAGE_FS_DIR: storageDir,
        TURN_SECRET,
        SESSION_COOKIE_SECRET: 'camera-multi-node-cookie-secret-0123456789',
        TOKEN_SIGNING_KEY: 'cd'.repeat(32),
        STUN_URLS: 'stun:turn.example.test:3478',
        TURN_URLS: 'turn:turn.example.test:3478?transport=udp',
        ICE_OWN_HOST_SUFFIXES: 'example.test',
      },
      { persistSecrets: false },
    );
    const presence = new RedisPresence(srv.client());
    const { app, ctx } = await buildApp({
      config,
      db,
      presence,
      logLevel: 'silent',
      metrics: createMetrics({ defaults: false }),
      timing: { graceMs: 400, tickMs: 50 },
    });
    await app.ready();
    await presence.heartbeatNode(nodeId, 90);
    const u = await listen(app);
    return {
      app,
      ctx,
      db,
      storageDir,
      url: u,
      close: async () => {
        await app.close();
        rmSync(storageDir, { recursive: true, force: true });
      },
    };
  }

  beforeAll(async () => {
    db = await makeDb();
    srv = new FakeRedisServer();
    A = await startNode('cam-node-a');
    B = await startNode('cam-node-b');
  });
  afterAll(async () => {
    await A.close();
    await B.close();
    await closeDb(db);
  });

  it('camera_busy, single use and DELETE work on the node that does not own the session', async () => {
    const acc = await signup(A.app);
    const k = new Kit(A, A.url);
    try {
      const s = await k.activeSession(acc); // Desk and Assist on A: A owns the session
      const res = await call(B.app, `/api/v1/sessions/${s.sessionId}/camera-links`, {
        method: 'POST',
        cookie: acc.cookie,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { cameraId: string; code: string };
      const busy = await call(A.app, `/api/v1/sessions/${s.sessionId}/camera-links`, {
        method: 'POST',
        cookie: acc.cookie,
      });
      expect(busy.json().error.code).toBe('camera_busy');
      const busyB = await call(B.app, `/api/v1/sessions/${s.sessionId}/camera-links`, {
        method: 'POST',
        cookie: acc.cookie,
      });
      expect(busyB.json().error.code).toBe('camera_busy');
      // the phone reaches the owner node and takes the code; the same code on B is spent
      const ph = await phone(A.url);
      await ph.request({ t: 'camera.hello', code: body.code }, 'camera.hello.ok');
      ph.send({ t: 'camera.ready', cameraId: body.cameraId, width: 640, height: 480, facing: 'environment' });
      await s.assist.next('camera.state', (m: Msg) => m.state === 'live');
      const again = await phone(B.url);
      again.send({ t: 'camera.hello', code: body.code });
      expect((await again.next('error')).code).toBe('camera_link_invalid');
      // a snapshot recorded through B asks the owner whether the camera is live
      const snap = await call(B.app, `/api/v1/sessions/${s.sessionId}/camera/${body.cameraId}/snapshots`, {
        cookie: acc.cookie,
        body: { sha256: 'c'.repeat(64), width: 640, height: 480 },
      });
      expect(snap.statusCode).toBe(201);
      // DELETE on B ends the camera on A
      const del = await call(B.app, `/api/v1/sessions/${s.sessionId}/camera-links/${body.cameraId}`, {
        method: 'DELETE',
        cookie: acc.cookie,
      });
      expect(del.statusCode).toBe(204);
      expect(await ph.next('camera.closed')).toMatchObject({ reason: 'assist' });
      await sleep(100);
      expect((await actions(s.sessionId, db)).find((e) => e.action === 'camera.ended')?.data).toMatchObject({
        by: 'assist',
      });
      expect(
        (await call(B.app, `/api/v1/sessions/${s.sessionId}/camera-links`, { method: 'POST', cookie: acc.cookie }))
          .statusCode,
      ).toBe(201);
    } finally {
      k.closeAll();
    }
  });
});
