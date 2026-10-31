/**
 * Phase C section 8.3 / F6: the pinned playbook manifest hashes are persisted on the session row, so the
 * `playbook_changed` run check succeeds on a node that does NOT own the session (its in-memory live registry has no
 * entry). Two api nodes share one database and one Redis-compatible presence store; the P3 session is owned by node A
 * (the Desk's node) and the playbook run request is made on node B.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getSession, type Db } from '@indiansassist/db';
import { RedisPresence } from '../src/adapters/presence-redis.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/lib/metrics.js';
import { FakeRedisServer } from './fake-redis.js';
import { call, createToken, listen, makeDb, signup, SignalClient, trackServerErrors, TURN_SECRET, WEB_ORIGIN, type Account, type TestApp } from './helpers.js';
import { AGENT_UA, NATIVE } from './p3-kit.js';

type Node = TestApp & { url: string; nodeId: string };

let db: Db;
let srv: FakeRedisServer;
let A: Node;
let B: Node;
const clients: SignalClient[] = [];

async function startNode(nodeId: string): Promise<Node> {
  const storageDir = mkdtempSync(join(tmpdir(), 'ia-api-pbmn-'));
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_DISABLED: 'true',
      NODE_ID: nodeId,
      SIGNUP_PLAN_TIER: 'p3_portable',
      WEB_ORIGIN,
      API_ORIGIN: 'http://localhost:4000',
      STORAGE_FS_DIR: storageDir,
      TURN_SECRET,
      SESSION_COOKIE_SECRET: 'pb-multinode-cookie-secret-0123456789abcdef',
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
  return {
    app,
    ctx,
    db,
    storageDir,
    url,
    nodeId,
    close: async () => {
      await app.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

async function open(node: Node, opts: Parameters<typeof SignalClient.open>[1] = {}): Promise<SignalClient> {
  const c = await SignalClient.open(node.url, opts);
  clients.push(c);
  return c;
}

/** A P3-seated admin on node A, an active P3 session with the Desk on A and the Assist on B. */
async function bridgedP3Active(): Promise<{ admin: Account; sessionId: string }> {
  const admin = await signup(A.app);
  const seat = await call(A.app, `/api/v1/users/${admin.user.id}/role`, { method: 'PATCH', cookie: admin.cookie, body: { role: admin.user.role, tier: 'p3_portable' } });
  expect(seat.statusCode).toBe(200);
  const { compact } = await createToken(A.app, admin, { tier: 'p3_portable', typ: 'one_time' });
  const assist = await open(B, { cookie: admin.cookie });
  await assist.request({ t: 'assist.hello' }, 'assist.hello.ok');
  const desk = await open(A, { origin: null, headers: { 'user-agent': AGENT_UA } });
  await desk.request({ t: 'desk.hello', token: compact, client: NATIVE }, 'desk.hello.ok');
  const knock = await desk.request({ t: 'desk.knock' }, 'knock.ok');
  const sessionId = knock.sessionId as string;
  await assist.next('assist.knock', (m) => m.sessionId === sessionId);
  await assist.request({ t: 'assist.accept', sessionId }, 'session.created');
  await desk.next('session.created', (m) => m.sessionId === sessionId);
  await desk.request({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1], clipboard: false } }, 'consent.ok');
  await assist.next('consent.changed');
  return { admin, sessionId };
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

describe('playbook run on a non-owner node (F6)', () => {
  it('runs a pinned playbook from node B though node A owns the session', async () => {
    const { admin, sessionId } = await bridgedP3Active();
    // Node A owns the session and holds the live manifest; node B has no live entry for it.
    expect((await getSession(db, sessionId))?.nodeId).toBe('node-a');
    expect(A.ctx.hub.live.has(sessionId)).toBe(true);
    expect(B.ctx.hub.live.has(sessionId)).toBe(false);
    // The pins were persisted on the session row by the owner node when the manifest was first built.
    const pins = (await getSession(db, sessionId))?.playbookPins ?? {};
    expect(Object.keys(pins).length).toBeGreaterThan(0);

    const list = (await call(B.app, '/api/v1/orgs/current/playbooks?limit=200', { cookie: admin.cookie })).json().items as { id: string; name: string }[];
    const flush = list.find((p) => p.name === 'Flush DNS cache')!;
    expect(flush).toBeDefined();

    const ok = await call(B.app, `/api/v1/sessions/${sessionId}/playbooks/${flush.id}/run`, { cookie: admin.cookie, body: { args: {} } });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().playbookId).toBe(flush.id);
  });
});
