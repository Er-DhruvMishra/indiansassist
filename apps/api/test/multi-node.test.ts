/**
 * prd-F2 / contracts section 7.6 N1: two api nodes (two SignalHubs, one database, one Redis-compatible presence
 * store) bridge a Desk on node A and an Assist on node B through knock -> accept -> consent -> relay -> end, held
 * knocks, REST calls on the non-owner node, a Desk resuming onto the other node and the grace end of a dropped
 * bridged socket.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getSession, listAuditBySession, type Db } from '@indiansassist/db';
import { RedisLimiter } from '../src/adapters/limiter-redis.js';
import { RedisPresence } from '../src/adapters/presence-redis.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/lib/metrics.js';
import { FakeRedisServer } from './fake-redis.js';
import { call, createToken, listen, makeDb, signup, SignalClient, trackServerErrors, TURN_SECRET, WEB_ORIGIN, type TestApp } from './helpers.js';
import { sleep } from './signal-kit.js';

type Node = TestApp & { url: string; nodeId: string };

let db: Db;
let srv: FakeRedisServer;
let A: Node;
let B: Node;
const clients: SignalClient[] = [];

async function startNode(nodeId: string): Promise<Node> {
  const storageDir = mkdtempSync(join(tmpdir(), 'ia-api-mn-'));
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DISABLED: 'true',
      NODE_ID: nodeId,
      WEB_ORIGIN,
      API_ORIGIN: 'http://localhost:4000',
      STORAGE_FS_DIR: storageDir,
      TURN_SECRET,
      SESSION_COOKIE_SECRET: 'multi-node-cookie-secret-0123456789abcdef',
      TOKEN_SIGNING_KEY: 'ab'.repeat(32),
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
  trackServerErrors(app);
  await app.ready();
  await presence.heartbeatNode(nodeId, 90);
  const url = await listen(app);
  return { app, ctx, db, storageDir, url, nodeId, close: async () => {
    await app.close();
    rmSync(storageDir, { recursive: true, force: true });
  } };
}

async function open(node: Node, cookie?: string): Promise<SignalClient> {
  const c = await SignalClient.open(node.url, cookie ? { cookie } : {});
  clients.push(c);
  return c;
}

async function assistOn(node: Node, cookie: string): Promise<SignalClient> {
  const a = await open(node, cookie);
  await a.request({ t: 'assist.hello' }, 'assist.hello.ok');
  return a;
}

async function deskOn(node: Node, token: string): Promise<SignalClient> {
  const d = await open(node);
  await d.request({ t: 'desk.hello', token, deskLabel: 'Front desk' }, 'desk.hello.ok');
  return d;
}

/** Desk on A, Assist on B, session active. */
async function bridgedActive() {
  const admin = await signup(A.app);
  const { compact } = await createToken(A.app, admin, { tier: 'p1_browser', typ: 'timed' });
  const assist = await assistOn(B, admin.cookie);
  const desk = await deskOn(A, compact);
  const knock = await desk.request({ t: 'desk.knock' }, 'knock.ok');
  const sessionId = knock.sessionId as string;
  await assist.next('assist.knock', (m) => m.sessionId === sessionId);
  const created = await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
  expect(created).toMatchObject({ sessionId, state: 'consent_pending', polite: true });
  await desk.next('session.created', (m) => m.sessionId === sessionId);
  await desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'consent.ok');
  expect(await assist.next('consent.changed')).toMatchObject({ sessionId, state: 'granted' });
  return { admin, assist, desk, sessionId, resumeKey: knock.resumeKey as string, compact };
}

beforeAll(async () => {
  db = await makeDb();
  srv = new FakeRedisServer();
  A = await startNode('node-a');
  B = await startNode('node-b');
});

afterAll(async () => {
  for (const c of clients) c.close();
  await A.close();
  await B.close();
  await closeDb(db);
});

describe('multi-node signaling bridge (section 7.6 N1)', () => {
  it('relays a session between a Desk on node A and an Assist on node B from knock to end', async () => {
    const { admin, assist, desk, sessionId } = await bridgedActive();
    expect((await getSession(db, sessionId))?.nodeId).toBe('node-a');
    expect(A.ctx.limiter).toBeInstanceOf(RedisLimiter); // limits are cluster-wide with the redis driver
    expect(A.ctx.hub.live.has(sessionId)).toBe(true);
    expect(B.ctx.hub.live.has(sessionId)).toBe(false);

    assist.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 offer' });
    expect((await desk.next('webrtc.offer')).sdp).toBe('v=0 offer');
    desk.send({ t: 'webrtc.answer', sessionId, sdp: 'v=0 answer' });
    expect((await assist.next('webrtc.answer')).sdp).toBe('v=0 answer');
    desk.send({ t: 'chat.message', sessionId, msgId: randomUUID(), ts: Date.now(), from: 'desk', text: 'hello from the desk' });
    expect(await assist.next('chat.message')).toMatchObject({ from: 'desk', text: 'hello from the desk' });
    assist.send({ t: 'chat.message', sessionId, msgId: randomUUID(), ts: Date.now(), from: 'assist', text: 'hi' });
    expect(await desk.next('chat.message')).toMatchObject({ from: 'assist', text: 'hi' });

    // Another technician of the org on node B is still refused by the owner.
    const intruder = await assistOn(B, admin.cookie);
    intruder.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 injected' });
    expect((await intruder.next('error')).code).toBe('forbidden');
    expect(await desk.quiet('webrtc.offer', 150)).toBe(true);

    assist.send({ t: 'session.end', sessionId });
    expect((await assist.next('session.ended')).endReason).toBe('assist_ended');
    expect((await desk.next('session.ended')).endReason).toBe('assist_ended');
    expect(await desk.closed()).toBe(4410);
    const actions = (await listAuditBySession(db, sessionId)).map((e) => e.action);
    expect(actions).toEqual([
      'session.knock',
      'session.accepted',
      'session.consent_granted',
      'session.started',
      'signal.forbidden',
      'chat.relayed',
      'session.ended',
    ]);
  });

  it('performs a held knock on node A when an eligible Assist says hello on node B', async () => {
    const admin = await signup(A.app);
    const { compact } = await createToken(A.app, admin, { tier: 'p1_browser', typ: 'timed' });
    const desk = await deskOn(A, compact);
    expect(await desk.request({ t: 'desk.knock' }, 'knock.held')).toMatchObject({ technicianOnline: false });
    const assist = await assistOn(B, admin.cookie);
    const ok = await desk.next('knock.ok');
    expect(await assist.next('assist.knock')).toMatchObject({ sessionId: ok.sessionId, canAct: true });
    // The Desk's node sees the remote technician as online.
    expect(await desk.request({ t: 'desk.poll' }, 'poll.status')).toMatchObject({ technicianOnline: true });
    assist.send({ t: 'assist.deny', sessionId: ok.sessionId });
    expect((await desk.next('session.ended')).endReason).toBe('denied');
  });

  it('routes REST calls made on the non-owner node to the owner', async () => {
    const { admin, assist, desk, sessionId } = await bridgedActive();
    desk.send({ t: 'chat.message', sessionId, msgId: randomUUID(), ts: Date.now(), from: 'desk', text: 'one' });
    await assist.next('chat.message');
    const rec = await call(B.app, `/api/v1/sessions/${sessionId}/events`, { cookie: admin.cookie, body: { action: 'recording.started', data: {} } });
    expect(rec.statusCode).toBe(201);
    expect((await desk.next('session.recording')).recording).toBe(true);
    const end = await call(B.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
    expect(end.statusCode).toBe(200);
    expect((await desk.next('session.ended')).endReason).toBe('assist_ended');
    expect((await assist.next('session.ended')).endReason).toBe('assist_ended');
    const relayed = (await listAuditBySession(db, sessionId)).find((e) => e.action === 'chat.relayed');
    expect(relayed?.data).toEqual({ count: 1 });
  });

  it('resumes a Desk onto node B for a session owned by node A and keeps relaying', async () => {
    const { assist, desk, sessionId, resumeKey, compact } = await bridgedActive();
    desk.close();
    await desk.closed();
    const desk2 = await open(B);
    const hello = await desk2.request({ t: 'desk.hello', token: compact, resumeKey }, 'desk.hello.ok');
    expect(hello.resume).toMatchObject({ sessionId, state: 'consent_pending' });
    expect(await assist.next('desk.reconnected')).toMatchObject({ sessionId, state: 'consent_pending' });
    expect((await getSession(db, sessionId))?.nodeId).toBe('node-a');
    await desk2.request({ t: 'desk.consent', state: 'granted', surface: 'monitor' }, 'consent.ok');
    desk2.send({ t: 'webrtc.offer', sessionId, sdp: 'v=0 again' });
    expect((await assist.next('webrtc.offer')).sdp).toBe('v=0 again');
    desk2.send({ t: 'session.end', sessionId });
    expect((await assist.next('session.ended')).endReason).toBe('desk_stopped');
    expect(await desk2.closed()).toBe(4410);
  });

  it('ends the session after the grace when the bridged Assist socket drops', async () => {
    const { assist, desk, sessionId } = await bridgedActive();
    assist.close();
    expect((await desk.next('session.ended', () => true, 5000)).endReason).toBe('error');
    await sleep(50);
    expect((await getSession(db, sessionId))?.state).toBe('ended');
  });

  it('tells a piped Assist that a session of a lost owner node ended', async () => {
    const { admin, assist, sessionId } = await bridgedActive();
    srv.data.delete('ia:node:node-a'); // node A is lost as far as the cluster can tell
    try {
      const end = await call(B.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} });
      expect(end.statusCode).toBe(200);
      expect(await assist.next('session.ended')).toMatchObject({ sessionId, endReason: 'assist_ended' });
    } finally {
      await A.ctx.presence.heartbeatNode('node-a', 90);
    }
  });

  it('fans token presence, revocation and sign-out out to the sockets on the other node', async () => {
    const admin = await signup(A.app);
    const { compact, token } = await createToken(A.app, admin, { tier: 'p1_browser', typ: 'timed' });
    const assist = await assistOn(A, admin.cookie);
    const desk = await deskOn(B, compact);
    expect(await assist.next('token.presence', (m) => m.tokenId === token.id)).toMatchObject({ waiting: true, held: false });
    const rev = await call(A.app, `/api/v1/tokens/${token.id}/revoke`, { cookie: admin.cookie, body: {} });
    expect(rev.statusCode).toBe(200);
    expect((await desk.next('error')).code).toBe('token_gone');
    expect(await desk.closed()).toBe(4403);
    const out = await call(B.app, '/api/v1/auth/logout', { cookie: admin.cookie, body: {} });
    expect(out.statusCode).toBeLessThan(300);
    expect(await assist.closed()).toBe(4401);
  });
});
