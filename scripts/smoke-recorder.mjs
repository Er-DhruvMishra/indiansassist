#!/usr/bin/env node
// IndiansAssist Phase A.2 smoke test (docs/specs/phase-a2-recorder.md): a Node `ws` client acts as the server
// recorder against a running api, with no browser and no media. `pnpm smoke:recorder`.
//
//   RECORDER_TOKEN=<same as the api> pnpm smoke:recorder     # API_URL defaults to http://localhost:4000
//
// Env:
//   API_URL           api origin (dev: http://localhost:4000)
//   RECORDER_TOKEN    the api's service token (required; the api must be started with the same value)
//   WEB_ORIGIN        Origin of the Assist / Desk sockets and REST calls (default: origin of well-known `join`)
//   SIGNAL_URL        override the WebSocket URL
//   SMOKE_TIMEOUT_MS  per-wait timeout (default 5000)
//
// Flow: signup (throwaway org) -> recording policy `server` -> recorder hello with the service token -> Assist and
// Desk sockets, knock, accept (session.created.recordingMode), consent -> recorder.assign / recorder.join ->
// session.recording { source: 'server' } on both sides -> recorder offer relayed to the Desk tagged peer:'recorder',
// the Desk's answer and ICE relayed back -> Desk ends -> session.ended to the recorder -> internal upload with the
// service token -> the session audit holds recording.server_started, recording.server_stopped, recording.stored
// { source: 'server' } in order, and the stored recording verifies. Exits 1 on any failure.

import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ApiClient, signalUrlFor } from './smoke/http.mjs';
import { check, Runner } from './smoke/runner.mjs';
import { SignalClient } from './smoke/ws-client.mjs';

const eq = (a, b, what) => check(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/** @param {{ apiUrl?: string, recorderToken?: string, webOrigin?: string, signalUrl?: string, timeoutMs?: number, log?: (l: string) => void }} [opts] */
export async function runSmokeRecorder(opts = {}) {
  const run = new Runner({ log: opts.log });
  const apiUrl = (opts.apiUrl ?? 'http://localhost:4000').replace(/\/+$/, '');
  const api = new ApiClient(apiUrl, { origin: opts.webOrigin ?? null });
  const tmo = opts.timeoutMs ?? 5000;
  const token = opts.recorderToken ?? '';
  const st = { webOrigin: opts.webOrigin ?? null, signalUrl: opts.signalUrl ?? null };
  const sockets = [];
  const open = async (name, headers) => {
    const c = new SignalClient(name, st.signalUrl, headers);
    sockets.push(c);
    return c.open(tmo);
  };
  run.log(`smoke recorder: ${apiUrl}`);
  try {
    await run.step('RECORDER_TOKEN is set', () => {
      check(token !== '', 'set RECORDER_TOKEN to the value the api was started with');
    });
    await run.step('GET /.well-known/indiansassist.json', async () => {
      const wk = await api.expect('GET', '/.well-known/indiansassist.json');
      st.webOrigin ??= new URL(wk.join).origin;
      st.signalUrl ??= wk.signal ?? signalUrlFor(apiUrl);
      api.origin = st.webOrigin;
      return `web origin ${st.webOrigin}, signal ${st.signalUrl}`;
    });
    await run.step('signup throwaway org and set recording policy to server', async () => {
      const id = `rec${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
      await api.expect(
        'POST',
        '/api/v1/auth/signup',
        {
          orgName: `Recorder smoke ${id}`,
          name: 'Smoke Admin',
          email: `${id}@example.test`,
          password: 'smoke-password-123',
        },
        [201],
      );
      const p = await api.expect('PATCH', '/api/v1/orgs/current/policy/recording', { recordingMode: 'server' });
      eq(p.recordingMode, 'server', 'recordingMode');
      const g = await api.expect('GET', '/api/v1/orgs/current/policy/recording');
      eq(g.recordingMode, 'server', 'GET recordingMode');
    });
    await run.step('recorder.hello with the service token (no Origin header)', async () => {
      const bad = await open('badrecorder', {});
      bad.send({
        t: 'recorder.hello',
        token: 'not-the-token',
        recorderId: 'smoke-bad',
        version: 'smoke',
        region: 'in-mum',
      });
      const err = await bad.next('error', tmo);
      eq(err.code, 'forbidden', 'wrong token error');
      eq((await bad.waitClose(tmo)).code, 4403, 'wrong token close code');
      st.rec = await open('recorder', {});
      st.rec.send({
        t: 'recorder.hello',
        token,
        recorderId: 'smoke-recorder',
        version: 'smoke',
        region: 'in-mum',
        maxSessions: 4,
      });
      const ok = await st.rec.reply('recorder.hello.ok', tmo);
      return `node ${ok.nodeId}, regions ${ok.regions.join(',')}`;
    });
    await run.step('Assist + Desk: knock, accept (session.created.recordingMode = server), consent', async () => {
      const created = await api.expect(
        'POST',
        '/api/v1/tokens',
        { tier: 'p1_browser', typ: 'one_time', label: 'recorder smoke' },
        [201],
      );
      st.assist = await open('assist', { Origin: st.webOrigin, Cookie: api.cookie });
      st.assist.send({ t: 'assist.hello' });
      await st.assist.reply('assist.hello.ok', tmo);
      st.desk = await open('desk', { Origin: st.webOrigin });
      st.desk.send({ t: 'desk.hello', token: created.compact, deskLabel: 'Recorder smoke desk' });
      await st.desk.reply('desk.hello.ok', tmo);
      st.desk.send({ t: 'desk.knock' });
      const knock = await st.desk.reply('knock.ok', tmo);
      st.sessionId = knock.sessionId;
      await st.assist.next((m) => m.t === 'assist.knock' && m.sessionId === st.sessionId, tmo, 'assist.knock');
      st.assist.send({ t: 'assist.accept', sessionId: st.sessionId });
      eq(
        (await st.assist.reply('session.created', tmo)).recordingMode,
        'server',
        'Assist session.created.recordingMode',
      );
      eq((await st.desk.next('session.created', tmo)).recordingMode, 'server', 'Desk session.created.recordingMode');
      st.desk.send({ t: 'desk.consent', state: 'granted', surface: 'monitor' });
      eq((await st.desk.reply('consent.ok', tmo)).state, 'active', 'consent.ok state');
      return `session ${st.sessionId}`;
    });
    await run.step('recorder.assign after consent, recorder.join -> recorder.joined', async () => {
      const a = await st.rec.next(
        (m) => m.t === 'recorder.assign' && m.sessionId === st.sessionId,
        tmo,
        'recorder.assign',
      );
      eq(a.recordingMode, 'server', 'assign recordingMode');
      eq(a.resume, false, 'assign resume');
      st.rec.send({ t: 'recorder.join', sessionId: st.sessionId });
      await st.rec.reply('recorder.joined', tmo);
    });
    await run.step('session.recording { source: server } reaches the Desk and the Assist', async () => {
      const pred = (m) => m.t === 'session.recording' && m.source === 'server' && m.recording === true;
      await st.desk.next(pred, tmo, 'Desk session.recording');
      await st.assist.next(pred, tmo, 'Assist session.recording');
    });
    await run.step('recorder offer -> Desk (peer: recorder); Desk answer and ICE -> recorder', async () => {
      st.rec.send({ t: 'webrtc.offer', sessionId: st.sessionId, sdp: 'v=0\r\no=- smoke-recorder\r\n' });
      const offer = await st.desk.next('webrtc.offer', tmo);
      eq(offer.peer, 'recorder', 'offer peer tag');
      st.desk.send({ t: 'webrtc.answer', sessionId: st.sessionId, sdp: 'v=0\r\no=- smoke-desk\r\n', peer: 'recorder' });
      eq((await st.rec.next('webrtc.answer', tmo)).peer, 'recorder', 'answer peer tag');
      st.desk.send({ t: 'webrtc.ice', sessionId: st.sessionId, candidate: null, peer: 'recorder' });
      await st.rec.next('webrtc.ice', tmo);
    });
    await run.step('Desk ends; the recorder receives session.ended (serverRecording: true)', async () => {
      st.desk.send({ t: 'session.end', sessionId: st.sessionId });
      const ended = await st.rec.next(
        (m) => m.t === 'session.ended' && m.sessionId === st.sessionId,
        tmo,
        'session.ended',
      );
      eq(ended.serverRecording, true, 'session.ended.serverRecording');
    });
    await run.step('POST /api/v1/internal/recordings with the service token', async () => {
      const file = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(2048)]);
      const sha256 = createHash('sha256').update(file).digest('hex');
      const meta = {
        sessionId: st.sessionId,
        recorderId: 'smoke-recorder',
        mime: 'video/webm;codecs="vp8,opus"',
        durationMs: 1500,
        bytes: file.length,
        sha256,
      };
      const form = new FormData();
      form.append('meta', JSON.stringify(meta));
      form.append('file', new Blob([file], { type: 'video/webm' }), `${st.sessionId}.webm`);
      const res = await fetch(`${apiUrl}/api/v1/internal/recordings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'IndiansAssist' },
        body: form,
      });
      const body = await res.json();
      eq(res.status, 201, `internal upload status (${JSON.stringify(body.error ?? null)})`);
      eq(body.recordedBy, 'server', 'recordedBy');
      eq(body.sha256, sha256, 'stored sha256');
      st.recordingId = body.id;
      return `recording ${body.id}, ${body.bytes} bytes`;
    });
    await run.step(
      'session audit: server_started, server_stopped, stored { source: server }, integrity ok',
      async () => {
        const a = await api.expect('GET', `/api/v1/sessions/${st.sessionId}/audit`);
        const names = a.items.map((e) => e.action);
        const i = (n) => names.indexOf(n);
        check(
          i('recording.server_started') > i('session.started'),
          `server_started missing or early: ${names.join(', ')}`,
        );
        check(
          i('recording.server_stopped') > i('recording.server_started'),
          'server_stopped missing or before server_started',
        );
        check(i('recording.server_stopped') < i('session.ended'), 'server_stopped after session.ended');
        const stopped = a.items[i('recording.server_stopped')];
        eq(stopped.data.reason, 'session_ended', 'server_stopped reason');
        eq(stopped.actor.label, 'recorder', 'recorder actor label');
        const stored = a.items[i('recording.stored')];
        check(stored, 'recording.stored missing');
        eq(stored.data.source, 'server', 'recording.stored source');
        eq(stored.data.recordingId, st.recordingId, 'recording.stored recordingId');
        eq(a.integrity.ok, true, 'session audit integrity');
        return `${names.length} entries`;
      },
    );
    await run.step('POST /api/v1/recordings/:id/verify (server recording)', async () => {
      const v = await api.expect('POST', `/api/v1/recordings/${st.recordingId}/verify`);
      eq(v.ok, true, 'verify ok');
      const s = await api.expect('GET', `/api/v1/sessions/${st.sessionId}`);
      eq(s.serverRecording, true, 'Session.serverRecording');
      eq(s.serverRecordingId, st.recordingId, 'Session.serverRecordingId');
    });
  } finally {
    for (const s of sockets) s.close();
  }
  run.log(`\nsmoke recorder: ${run.summary()} -> ${run.ok ? 'PASS' : 'FAIL'}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const timeout = Number(env.SMOKE_TIMEOUT_MS);
  runSmokeRecorder({
    apiUrl: env.API_URL || 'http://localhost:4000',
    recorderToken: env.RECORDER_TOKEN || '',
    webOrigin: env.WEB_ORIGIN || undefined,
    signalUrl: env.SIGNAL_URL || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 5000,
  })
    .then((run) => process.exit(run.ok ? 0 : 1))
    .catch((err) => {
      console.error(`FAIL  smoke recorder crashed: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(1);
    });
}
