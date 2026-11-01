/**
 * Phase D worker credential (docs/specs/phase-d-contracts.md section 4.2, rule 3.6d, section 15.3 "expiry and
 * cross-node adoption"): the two halves `p4.test.ts` and the smoke do not reach -- the `workerCredentialTtlSec`
 * expiry (a credential that outlives its window is refused exactly like a spent one, and the service can ask for a
 * fresh one over its own socket), and rule 3.6d, a worker presenting its credential on a node that does **not** own
 * the session: the hello is completed by the owner node while the owner is alive, and adopted locally once the
 * owner is gone. The TTL half runs on a `MemoryPresence` with a clock the test moves, so no test waits two minutes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, WS_CLOSE } from '@indiansassist/shared';
import { closeDb, getSession, type Db } from '@indiansassist/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryPresence } from '../src/adapters/presence.js';
import { RedisPresence } from '../src/adapters/presence-redis.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/lib/metrics.js';
import { FakeRedisServer } from './fake-redis.js';
import {
  call,
  listen,
  makeDb,
  trackServerErrors,
  TURN_SECRET,
  WEB_ORIGIN,
  type Account,
  type Msg,
  type SignalClient,
  type TestApp,
} from './helpers.js';
import { connectDevice, deviceGroup, enrollDevice, makeP4App, openDeviceSessionVia, p4Admin, workerHelloWith } from './p4-kit.js';

describe('the worker credential expires (section 4.2)', () => {
  let t: TestApp;
  let url: string;
  let admin: Account;
  const clock = { now: Date.now() };
  const sockets: SignalClient[] = [];

  beforeAll(async () => {
    t = await makeP4App({}, { presence: new MemoryPresence('test-node', () => clock.now) });
    url = await listen(t.app);
    admin = await p4Admin(t);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await t.close();
  });

  it('is refused once its window has passed, and the service can mint a fresh one on its own socket', async () => {
    const group = await deviceGroup(t, admin, { mode: 'allow', recordingRequired: false });
    const d = await enrollDevice(t, admin, { groupId: group });
    const ws = await connectDevice(url, d, { track: sockets });
    await ws.next('device.hello.ok');
    const { sessionId, open } = await openDeviceSessionVia(t, admin, d, ws);
    // Section 4.2: gen 0 arrives with the session, carrying the window it is good for.
    const issuedAt = Date.now();
    const expiresAt = Date.parse(String(open['workerCredentialExpiresAt']));
    expect(String(open['workerCredential'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt - issuedAt).toBeGreaterThan((LIMITS.workerCredentialTtlSec - 5) * 1000);
    expect(expiresAt - issuedAt).toBeLessThanOrEqual(LIMITS.workerCredentialTtlSec * 1000);

    // The desktop worker was slow to start: past the window, the credential is simply not there any more.
    clock.now += (LIMITS.workerCredentialTtlSec + 1) * 1000;
    const late = await workerHelloWith(url, open['workerCredential'], { track: sockets });
    expect((await late.next('error'))['code']).toBe('unauthenticated');
    expect(await late.closed()).toBe(WS_CLOSE.unauthenticated);

    // Rule 3.6d: the service asks for another one over its authenticated socket (a rebuild or a worker restart).
    const minted = (await ws.request({ t: 'device.worker_credential.request', sessionId, gen: 1 }, 'device.worker_credential')) as Msg;
    expect(minted).toMatchObject({ sessionId, gen: 1 });
    expect(String(minted['workerCredential'])).not.toBe(String(open['workerCredential']));
    const worker = await workerHelloWith(url, minted['workerCredential'], { track: sockets });
    const ok = await worker.next('desk.hello.ok');
    expect(ok).toMatchObject({ tokenId: null, tier: 'p4_installed' });
    expect((await worker.next('session.created'))['sessionId']).toBe(sessionId);

    // Single use: the credential it joined with is spent, and a replay is refused like an expired one.
    const replay = await workerHelloWith(url, minted['workerCredential'], { track: sockets });
    expect((await replay.next('error'))['code']).toBe('unauthenticated');
    expect(await replay.closed()).toBe(WS_CLOSE.unauthenticated);

    // A credential for a session that has ended is refused as `session_not_found`, not accepted into nothing.
    const stale = (await ws.request({ t: 'device.worker_credential.request', sessionId, gen: 2 }, 'device.worker_credential')) as Msg;
    expect((await call(t.app, `/api/v1/sessions/${sessionId}/end`, { cookie: admin.cookie, body: {} })).statusCode).toBe(200);
    const after = await workerHelloWith(url, stale['workerCredential'], { track: sockets });
    expect((await after.next('error'))['code']).toBe('session_not_found');
    expect(await after.closed()).toBe(WS_CLOSE.forbidden);
    // And the service cannot ask for one for an ended session at all.
    ws.send({ t: 'device.worker_credential.request', sessionId, gen: 3, id: 'c-ended' });
    expect((await ws.next('error', (m) => m['re'] === 'c-ended'))['code']).toBe('bad_state');
  });
});

type Node = TestApp & { url: string; nodeId: string };

describe('a worker adopted on a node that does not own the session (rule 3.6d)', () => {
  let db: Db;
  let srv: FakeRedisServer;
  let A: Node;
  let B: Node;
  let admin: Account;
  const sockets: SignalClient[] = [];

  async function startNode(nodeId: string): Promise<Node> {
    const storageDir = mkdtempSync(join(tmpdir(), 'ia-api-wc-'));
    const config = loadConfig(
      {
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_DISABLED: 'true',
        NODE_ID: nodeId,
        SIGNUP_PLAN_TIER: 'p4_installed',
        WEB_ORIGIN,
        API_ORIGIN: 'http://localhost:4000',
        STORAGE_FS_DIR: storageDir,
        TURN_SECRET,
        SESSION_COOKIE_SECRET: 'worker-credential-cookie-secret-0123456789',
        TOKEN_SIGNING_KEY: 'ab'.repeat(32),
        FLEET_DATA_KEY: `k1:${'cd'.repeat(32)}`,
        STUN_URLS: 'stun:turn.example.test:3478',
        TURN_URLS: 'turn:turn.example.test:3478?transport=udp',
        ICE_OWN_HOST_SUFFIXES: 'example.test',
      },
      { persistSecrets: false },
    );
    const presence = new RedisPresence(srv.client());
    const { app, ctx } = await buildApp({ config, db, presence, logLevel: 'silent', metrics: createMetrics({ defaults: false }), timing: { graceMs: 400, tickMs: 50 } });
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

  beforeAll(async () => {
    db = await makeDb();
    srv = new FakeRedisServer();
    A = await startNode('node-a');
    B = await startNode('node-b');
    admin = await p4Admin(A);
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await A.close();
    await B.close();
    await closeDb(db);
  });

  it('is completed by the owner node while it is alive, and adopted locally once the owner is gone', async () => {
    const group = await deviceGroup(A, admin, { mode: 'allow', recordingRequired: false });
    const d = await enrollDevice(A, admin, { groupId: group });
    const device = await connectDevice(A.url, d, { track: sockets });
    await device.next('device.hello.ok');
    const { sessionId, open } = await openDeviceSessionVia(A, admin, d, device, { unattended: true, reason: 'cross-node worker' });
    expect((await getSession(db, sessionId))?.nodeId).toBe('node-a');

    // The worker's socket lands on B, which holds no live entry for this session: A completes the hello over the
    // bridge and keeps the session (section 7.6 N1).
    const onB = await workerHelloWith(B.url, open['workerCredential'], { track: sockets });
    const ok = await onB.next('desk.hello.ok');
    expect(ok).toMatchObject({ tokenId: null, tier: 'p4_installed' });
    const created = await onB.next('session.created');
    expect(created['sessionId']).toBe(sessionId);
    expect((created['device'] as { id: string }).id).toBe(d.deviceId);
    expect((await getSession(db, sessionId))?.nodeId).toBe('node-a');
    // The console's view of the session is the same on either node.
    const viaB = await call(B.app, `/api/v1/sessions/${sessionId}`, { cookie: admin.cookie });
    expect(viaB.statusCode, viaB.body).toBe(200);
    expect(viaB.json()).toMatchObject({ id: sessionId, unattended: true });

    // Now A is lost (its heartbeat is gone, as after a crash). The next worker hello on B is adopted there.
    const fresh = await device.request({ t: 'device.worker_credential.request', sessionId, gen: 1 }, 'device.worker_credential');
    await B.ctx.presence.delKey('ia:node:node-a');
    expect(await B.ctx.presence.isNodeAlive('node-a')).toBe(false);
    const adopted = await workerHelloWith(B.url, fresh['workerCredential'], { track: sockets });
    expect(await adopted.next('desk.hello.ok')).toMatchObject({ tokenId: null, tier: 'p4_installed' });
    expect((await adopted.next('session.created'))['sessionId']).toBe(sessionId);
    expect((await getSession(db, sessionId))?.nodeId).toBe('node-b');
    // B now holds the session's Desk itself: the adopting node has a live entry with a local worker socket, and
    // the socket that was piped to the lost owner is not it (A is gone, so nothing can be relayed through it).
    expect(B.ctx.hub.live.get(sessionId)?.deskConnId).toBeTruthy();
    expect(await onB.quiet('session.created', 200)).toBe(true);
    await A.ctx.presence.heartbeatNode('node-a', 90);
  });
});
