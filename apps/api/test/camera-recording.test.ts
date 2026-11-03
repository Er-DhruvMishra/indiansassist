/**
 * Phase F section 6.5a (gate section 15.5 "recording"): the phone camera is recorded whenever the session is.
 * Server: the joined A.2 recorder that advertises `features: ['camera']` gets `recorder.camera`, the camera <-> recorder
 * frames are relayed (and nothing else), its upload with `source: 'camera'` is stored as a separate recording whose
 * chain entries carry `cameraId`; a recorder without the feature refuses the link (`camera_unrecordable`). Console:
 * the console's camera upload is stored the same way. The phone learns the state in `camera.hello.ok.recording` and
 * `camera.state { recording }`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listAuditBySession, listRecordingsBySession } from '@indiansassist/db';
import { call, listen, makeApp, signup, SignalClient, type Account, type TestApp } from './helpers.js';
import { Kit } from './signal-kit.js';

const TOKEN = 'camera-recorder-token-0123456789abcdef';
let t: TestApp;
let url: string;
let admin: Account;
let kit: Kit;
const extra: SignalClient[] = [];

beforeAll(async () => {
  t = await makeApp({ RECORDER_TOKEN: TOKEN }, { recorderJoinTimeoutMs: 2_000, tickMs: 50 });
  url = await listen(t.app);
  admin = await signup(t.app);
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  kit?.closeAll();
  for (const c of extra.splice(0)) c.close();
});

async function setMode(mode: string): Promise<void> {
  const res = await call(t.app, '/api/v1/orgs/current/policy/recording', {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { recordingMode: mode },
  });
  expect(res.statusCode).toBe(200);
}

async function open(): Promise<SignalClient> {
  const c = await SignalClient.open(url);
  extra.push(c);
  return c;
}

/**
 * A recorder socket. `recorder.hello.features` is parsed by the shared schema, but the A.2 hello handler
 * (`signal/recorder.ts`, not owned by the camera stream) does not keep it yet; until it does (proposed contract
 * correction), the test sets it on the server-side connection as that handler would.
 */
async function recorderOnline(camera: boolean): Promise<SignalClient> {
  const r = await open();
  const ok = await r.request(
    {
      t: 'recorder.hello',
      token: TOKEN,
      recorderId: camera ? 'rec-cam' : 'rec-old',
      version: '0.2.0',
      region: 'in-mum',
      ...(camera ? { features: ['camera'] } : {}),
    },
    'recorder.hello.ok',
  );
  const conn = t.ctx.hub.conns.get(ok.connectionId as string)!;
  if (camera && conn.recorder) (conn.recorder as { features?: string[] }).features ??= ['camera'];
  return r;
}

async function joinedServerSession(camera: boolean) {
  await setMode('server');
  kit = new Kit(t, url);
  const rec = await recorderOnline(camera);
  const s = await kit.activeSession(admin);
  await rec.next('recorder.assign', (m) => m.sessionId === s.sessionId);
  await rec.request({ t: 'recorder.join', sessionId: s.sessionId }, 'recorder.joined');
  return { ...s, rec };
}

function multipart(meta: unknown, file: Buffer): { body: Buffer; type: string } {
  const b = `----ia${randomBytes(8).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.webm"\r\nContent-Type: video/webm\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}

describe('server recording of the camera', () => {
  it('refuses the link when the joined recorder cannot record a camera (camera_unrecordable)', async () => {
    const s = await joinedServerSession(false);
    const res = await call(t.app, `/api/v1/sessions/${s.sessionId}/camera-links`, {
      method: 'POST',
      cookie: admin.cookie,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('camera_unrecordable');
  });

  it('records the camera as a second peer of the recorder and stores it as a separate recording', async () => {
    const s = await joinedServerSession(true);
    const res = await call(t.app, `/api/v1/sessions/${s.sessionId}/camera-links`, {
      method: 'POST',
      cookie: admin.cookie,
    });
    expect(res.statusCode).toBe(201);
    const link = res.json() as { cameraId: string; code: string };
    const ph = await open();
    const ok = await ph.request({ t: 'camera.hello', code: link.code }, 'camera.hello.ok');
    expect(ok.recording).toEqual({ server: true, console: false });
    // before the track starts, the recorder is not asked
    expect(await s.rec.quiet('recorder.camera', 300)).toBe(true);
    ph.send({ t: 'camera.ready', cameraId: link.cameraId, width: 1280, height: 720, facing: 'environment' });
    expect(await s.rec.next('recorder.camera')).toMatchObject({ sessionId: s.sessionId, cameraId: link.cameraId });
    // the recorder offers, the phone answers: relayed between those two sockets only, peer-tagged
    s.rec.send({ t: 'webrtc.offer', sessionId: s.sessionId, sdp: 'v=0 rec-offer', peer: 'camera' });
    expect(await ph.next('webrtc.offer')).toMatchObject({
      sessionId: s.sessionId,
      sdp: 'v=0 rec-offer',
      peer: 'recorder',
    });
    ph.send({ t: 'webrtc.answer', sessionId: s.sessionId, sdp: 'v=0 phone-answer', peer: 'recorder' });
    expect(await s.rec.next('webrtc.answer', (m) => m.peer === 'camera')).toMatchObject({ sdp: 'v=0 phone-answer' });
    expect(await s.assist.quiet('webrtc.answer', 200)).toBe(true);
    // the Desk cannot reach the camera's recorder path
    s.desk.send({ t: 'webrtc.answer', sessionId: s.sessionId, sdp: 'v=0', peer: 'camera' });
    expect((await s.desk.next('error')).code).toBe('forbidden');

    // the recorder's camera upload: a separate row, chain entries with cameraId
    const file = randomBytes(2048);
    const meta = {
      sessionId: s.sessionId,
      recorderId: 'rec-cam',
      mime: 'video/webm;codecs="vp8"',
      durationMs: 1500,
      bytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
      source: 'camera',
      cameraId: link.cameraId,
    };
    const mp = multipart(meta, file);
    const up = await call(t.app, '/api/v1/internal/recordings', {
      body: mp.body,
      headers: { 'content-type': mp.type, authorization: `Bearer ${TOKEN}` },
    });
    expect(up.statusCode).toBe(201);
    const rows = await listRecordingsBySession(t.db, s.sessionId);
    const cam = rows.find((r) => r.source === 'camera');
    expect(cam).toMatchObject({ cameraId: link.cameraId, recordedBy: 'server', status: 'stored' });
    // the Desk's own server recording still fits beside it (one per recorder and camera)
    const deskFile = randomBytes(1024);
    const deskMeta = {
      ...meta,
      mime: 'video/webm;codecs="vp8,opus"',
      bytes: deskFile.length,
      sha256: createHash('sha256').update(deskFile).digest('hex'),
    };
    delete (deskMeta as Partial<typeof deskMeta>).source;
    delete (deskMeta as Partial<typeof deskMeta>).cameraId;
    const dmp = multipart(deskMeta, deskFile);
    expect(
      (
        await call(t.app, '/api/v1/internal/recordings', {
          body: dmp.body,
          headers: { 'content-type': dmp.type, authorization: `Bearer ${TOKEN}` },
        })
      ).statusCode,
    ).toBe(201);
    expect((await listRecordingsBySession(t.db, s.sessionId)).filter((r) => r.status === 'stored')).toHaveLength(2);

    await call(t.app, `/api/v1/sessions/${s.sessionId}/camera-links/${link.cameraId}`, {
      method: 'DELETE',
      cookie: admin.cookie,
    });
    await ph.next('camera.closed');
    const entries = (await listAuditBySession(t.db, s.sessionId)).map((e) => ({
      action: e.action,
      data: e.data as Record<string, unknown>,
    }));
    const started = entries.filter((e) => e.action === 'recording.server_started');
    expect(started.map((e) => e.data.cameraId)).toEqual([undefined, link.cameraId]);
    const stored = entries.filter((e) => e.action === 'recording.stored');
    expect(stored.find((e) => e.data.cameraId === link.cameraId)?.data).toMatchObject({
      source: 'server',
      recordingId: cam!.id,
    });
    expect(stored.some((e) => e.data.cameraId === undefined)).toBe(true);
    expect(
      entries.find((e) => e.action === 'recording.server_stopped' && e.data.cameraId === link.cameraId)?.data,
    ).toMatchObject({ reason: 'track_ended' });
  });
});

describe('console recording of the camera', () => {
  it('tells the phone when the console starts recording, and stores the console camera upload', async () => {
    await setMode('assist_only');
    kit = new Kit(t, url);
    const s = await kit.activeSession(admin);
    const link = (
      await call(t.app, `/api/v1/sessions/${s.sessionId}/camera-links`, { method: 'POST', cookie: admin.cookie })
    ).json() as { cameraId: string; code: string };
    const ph = await open();
    const ok = await ph.request({ t: 'camera.hello', code: link.code }, 'camera.hello.ok');
    expect(ok.recording).toEqual({ server: false, console: false });
    ph.send({ t: 'camera.ready', cameraId: link.cameraId, width: 640, height: 480, facing: 'user' });
    await s.assist.next('camera.state', (m) => m.state === 'live');
    // the console starts its session recording: the phone shows "Recording" at once (state re-read within ~2 s)
    const ev = await call(t.app, `/api/v1/sessions/${s.sessionId}/events`, {
      cookie: admin.cookie,
      body: { action: 'recording.started', data: {} },
    });
    expect(ev.statusCode).toBeLessThan(300);
    expect(
      await ph.next('camera.state', (m) => (m.recording as { console?: boolean } | undefined)?.console === true, 5000),
    ).toMatchObject({
      cameraId: link.cameraId,
      state: 'live',
      recording: { server: false, console: true },
    });

    const file = randomBytes(4096);
    const mp = multipart({ mime: 'video/webm;codecs=vp8', durationMs: 2000 }, file);
    const up = await call(t.app, `/api/v1/sessions/${s.sessionId}/camera/${link.cameraId}/recordings`, {
      cookie: admin.cookie,
      body: mp.body,
      headers: { 'content-type': mp.type },
    });
    expect(up.statusCode).toBe(201);
    const row = (await listRecordingsBySession(t.db, s.sessionId)).find((r) => r.source === 'camera');
    expect(row).toMatchObject({ cameraId: link.cameraId, recordedBy: 'assist', status: 'stored', bytes: file.length });
    const entry = (await listAuditBySession(t.db, s.sessionId)).find((e) => e.action === 'recording.stored');
    expect(entry?.data).toMatchObject({
      recordingId: row!.id,
      cameraId: link.cameraId,
      sha256: createHash('sha256').update(file).digest('hex'),
    });
    expect((entry?.data as Record<string, unknown>).source).toBeUndefined();
    // a camera that never belonged to the session is refused
    const other = await call(
      t.app,
      `/api/v1/sessions/${s.sessionId}/camera/00000000-0000-4000-8000-0000000000aa/recordings`,
      {
        cookie: admin.cookie,
        body: mp.body,
        headers: { 'content-type': mp.type },
      },
    );
    expect(other.statusCode).toBe(404);
  });
});
