// Phase F smoke flow, stream camera (docs/specs/phase-f-contracts.md sections 6, 15.5), over signaling only: a throwaway
// org, a live P1 session (Assist and Desk sockets), `POST /sessions/:id/camera-links`, a phone socket that says
// `camera.hello { code }` (camera.hello.ok, TURN for `camera:<id>`, the recording flags), `camera.ready` (the Assist sees
// `camera.state live`), the camera <-> Assist offer relay (`peer: 'camera'`), a snapshot recorded by hash, the phone's
// `camera.stop`, the spent code refused with 4403, and the chain entries (`camera.link_created`, `.started`,
// `.snapshot`, `.ended`). No media flows: the SDP is a stand-in. Picked up by scripts/smoke-f.mjs. The address is
// synthetic (@example.com).

import { randomBytes } from 'node:crypto';
import { signalUrlFor } from './http.mjs';
import { check, eq } from './runner.mjs';
import { assertServerFrame, loadShared } from './shared.mjs';
import { SignalClient } from './ws-client.mjs';

const FAKE_OFFER =
  'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 AA:BB\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const FAKE_ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 CC:DD\r\n';

/** @param {import('./runner.mjs').Runner} run */
export async function flowSteps(run, ctx) {
  const { api, cfg, state } = ctx;
  const shared = await loadShared();
  const T = cfg.timeoutMs;
  const frame = (m, label) => assertServerFrame(shared, m, label);
  const suffix = randomBytes(4).toString('hex');
  const signalUrl = () => cfg.signalUrl ?? signalUrlFor(cfg.apiUrl);
  const open = async (name, headers) => {
    const c = new SignalClient(name, signalUrl(), headers);
    ctx.sockets.push(c);
    await c.open(T);
    return c;
  };

  await run.step('camera: a throwaway org and a live P1 session', async () => {
    const wk = await api.expect('GET', '/.well-known/indiansassist.json');
    if (!cfg.webOrigin) cfg.webOrigin = new URL(wk.join).origin;
    api.origin = cfg.webOrigin;
    const r = await api.expect(
      'POST',
      '/api/v1/auth/signup',
      {
        orgName: `Smoke Camera ${suffix}`,
        name: `Smoke Tech ${suffix}`,
        email: `smoke-camera-${suffix}@example.com`,
        password: `Smoke-${randomBytes(12).toString('base64url')}`,
      },
      [201],
    );
    state.user = r.user;
    const tok = await api.expect('POST', '/api/v1/tokens', { tier: 'p1_browser', typ: 'timed' }, [201]);
    state.assist = await open('assist', { Origin: cfg.webOrigin, Cookie: api.cookie });
    state.assist.send({ t: 'assist.hello' });
    frame(await state.assist.reply('assist.hello.ok', T), 'assist.hello.ok');
    state.desk = await open('desk', { Origin: cfg.webOrigin });
    state.desk.send({ t: 'desk.hello', token: tok.compact, deskLabel: 'Smoke camera Desk' });
    await state.desk.reply('desk.hello.ok', T);
    state.desk.send({ t: 'desk.knock' });
    const knock = await state.desk.reply('knock.ok', T);
    state.sessionId = knock.sessionId;
    await state.assist.next((m) => m.t === 'assist.knock' && m.sessionId === knock.sessionId, T, 'assist.knock');
    state.assist.send({ t: 'assist.accept', sessionId: knock.sessionId });
    await state.assist.reply('session.created', T);
    await state.desk.reply('session.created', T);
    state.desk.send({ t: 'desk.consent', state: 'granted', surface: 'monitor' });
    eq((await state.desk.reply('consent.ok', T)).state, 'active', 'consent.ok state');
    return `session ${knock.sessionId}`;
  });

  await run.step(
    'camera: POST camera-links -> 201 { cameraId, url, code, expiresAt }; camera.state linked',
    async () => {
      const link = await api.expect('POST', `/api/v1/sessions/${state.sessionId}/camera-links`, undefined, [201]);
      check(/^[0-9A-HJKMNP-TV-Z]{12}$/.test(link.code), 'the code is 12 Crockford characters');
      eq(link.url, `${cfg.webOrigin}/c/${link.code}`, 'the link url');
      const ttl = Date.parse(link.expiresAt) - Date.now();
      check(ttl > 590_000 && ttl <= 600_000, `expiresAt is ${ttl} ms away, expected about 600 s`);
      const st = frame(
        await state.assist.next(
          (m) => m.t === 'camera.state' && m.cameraId === link.cameraId,
          T,
          'camera.state linked',
        ),
        'camera.state',
      );
      eq(st.state, 'linked', 'camera.state');
      const busy = await api.request('POST', `/api/v1/sessions/${state.sessionId}/camera-links`);
      eq(busy.json?.error?.code, 'camera_busy', 'a second link');
      state.link = link;
      return `camera ${link.cameraId}`;
    },
  );

  await run.step('camera: phone camera.hello { code } -> camera.hello.ok; Assist and Desk see joined', async () => {
    state.phone = await open('phone', { Origin: cfg.webOrigin });
    state.phone.send({
      t: 'camera.hello',
      code: `${state.link.code.slice(0, 4)}-${state.link.code.slice(4, 8)}-${state.link.code.slice(8)}`.toLowerCase(),
    });
    const ok = frame(await state.phone.reply('camera.hello.ok', T), 'camera.hello.ok');
    eq(ok.cameraId, state.link.cameraId, 'cameraId');
    eq(ok.sessionId, state.sessionId, 'sessionId');
    eq(ok.technician.name, state.user.name, 'technician.name');
    eq(ok.limits.maxBitrateKbps, 1500, 'limits.maxBitrateKbps');
    check(typeof ok.recording?.server === 'boolean' && typeof ok.recording?.console === 'boolean', 'recording flags');
    for (const s of ok.iceServers)
      if (s.username)
        check(String(s.username).includes(`camera:${ok.cameraId}`), 'TURN credentials name camera:<cameraId>');
    await state.assist.next((m) => m.t === 'camera.state' && m.state === 'joined', T, 'camera.state joined');
    await state.desk.next((m) => m.t === 'camera.state' && m.state === 'joined', T, 'Desk camera.state joined');
  });

  await run.step(
    'camera: camera.ready -> camera.state live; the offer reaches the Assist tagged peer camera',
    async () => {
      state.phone.send({
        t: 'camera.ready',
        cameraId: state.link.cameraId,
        width: 1280,
        height: 720,
        facing: 'environment',
      });
      await state.assist.next((m) => m.t === 'camera.state' && m.state === 'live', T, 'camera.state live');
      state.phone.send({ t: 'webrtc.offer', sessionId: state.sessionId, sdp: FAKE_OFFER });
      const offer = frame(
        await state.assist.next((m) => m.t === 'webrtc.offer' && m.peer === 'camera', T, 'camera offer'),
        'webrtc.offer',
      );
      eq(offer.sessionId, state.link.cameraId, 'the camera frame carries the camera id');
      state.assist.send({ t: 'webrtc.answer', sessionId: state.sessionId, sdp: FAKE_ANSWER, peer: 'camera' });
      const answer = frame(await state.phone.reply('webrtc.answer', T), 'webrtc.answer');
      eq(answer.sdp, FAKE_ANSWER, 'answer sdp');
      check(!state.desk.queue.some((m) => m.t === 'webrtc.offer'), 'the camera offer reached the Desk');
    },
  );

  await run.step('camera: snapshot recorded by hash -> 201', async () => {
    const sha256 = randomBytes(32).toString('hex');
    await api.expect(
      'POST',
      `/api/v1/sessions/${state.sessionId}/camera/${state.link.cameraId}/snapshots`,
      { sha256, width: 1280, height: 720 },
      [201],
    );
    state.snapshotSha = sha256;
  });

  await run.step('camera: the phone stops -> camera.closed, Assist camera.state ended', async () => {
    state.phone.send({ t: 'camera.stop', cameraId: state.link.cameraId, reason: 'phone_stopped' });
    const closed = frame(await state.phone.reply('camera.closed', T), 'camera.closed');
    eq(closed.reason, 'phone_stopped', 'camera.closed reason');
    eq((await state.phone.waitClose(T)).code, 1000, 'phone close code');
    const st = await state.assist.next((m) => m.t === 'camera.state' && m.state === 'ended', T, 'camera.state ended');
    eq(st.reason, 'phone_stopped', 'camera.state reason');
  });

  await run.step('camera: the spent code -> camera_link_invalid + 4403', async () => {
    const again = await open('phone-2', { Origin: cfg.webOrigin });
    again.send({ t: 'camera.hello', code: state.link.code });
    const e = await again.next('error', T);
    eq(e.code, 'camera_link_invalid', 'error code');
    eq((await again.waitClose(T)).code, 4403, 'close code');
  });

  await run.step('camera: the chain holds link_created, started, snapshot, ended (and never the code)', async () => {
    const audit = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/audit`);
    const actions = audit.items.map((e) => e.action);
    for (const a of ['camera.link_created', 'camera.started', 'camera.snapshot', 'camera.ended'])
      check(actions.includes(a), `${a} missing from the chain`);
    const snap = audit.items.find((e) => e.action === 'camera.snapshot');
    eq(snap.data.sha256, state.snapshotSha, 'camera.snapshot sha256');
    check(!JSON.stringify(audit.items).includes(state.link.code), 'the camera code appears in the chain');
    eq(audit.integrity?.ok, true, 'chain integrity');
    await api.expect('POST', `/api/v1/sessions/${state.sessionId}/end`, {}, [200, 204]);
    return `${actions.filter((a) => a.startsWith('camera.')).length} camera entries`;
  });
}
