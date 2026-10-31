// Phase C cases of `pnpm smoke:recorder` (docs/specs/phase-c-contracts.md sections 3.7, 9 R2, 15.4): the server
// recorder is assigned to a p3_portable session, a native fake Desk (Origin-less socket) answers its offer, the
// elevation hand-over pauses the recorder and re-assigns it (`resume: true`), the elevated Desk answers the re-offer,
// and the server recording of the whole session (before and after the hand-over) is uploaded and chained; a native
// Desk without the `recorder` feature (today's Windows agent) is never assigned the recorder.

import { createHash, randomBytes } from 'node:crypto';
import { check } from './runner.mjs';
import { SignalClient } from './ws-client.mjs';

const eq = (a, b, what) => check(a === b, `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const UA = 'IndiansAssist-Agent/0.3.0 (Windows 10.0.26100; x64)';
const NATIVE = {
  kind: 'native',
  version: '0.3.0',
  os: 'windows',
  platform: { osVersion: '10.0.26100', arch: 'x64' },
  tokenSource: 'filename',
  // `recorder`: this fake Desk answers the recorder offer, so the API assigns one (section 9 R2 amendment).
  capabilities: { monitors: 1, elevation: 'user', features: ['screen', 'input', 'elevation', 'recorder'], encoders: ['vp8'], hwEncoder: false, interpreters: ['powershell', 'cmd'] },
};
const ADMIN = { ...NATIVE, capabilities: { ...NATIVE.capabilities, elevation: 'admin' } };
/** A native Desk that does not advertise `recorder` (today's Windows agent). */
const NO_RECORDER = { ...NATIVE, capabilities: { ...NATIVE.capabilities, features: ['screen', 'input', 'elevation'] } };
/** True when nothing matching `pred` arrives on `ws` within `ms`. */
const absent = (ws, pred, ms) => ws.next(pred, ms).then(() => false, () => true);
const OP = 'abcabcabcabcabca';

/**
 * Appends the P3 recorder steps to `run`. `st` holds the P1 flow's state (`rec`, `assist`, `signalUrl`); `open`
 * opens a tracked socket. Returns false (no steps added) when the org's plan does not include P3.
 */
export async function recorderP3Steps(run, { api, apiUrl, st, open, tmo, token, planTier, userId }) {
  if (planTier !== 'p3_portable' && planTier !== 'p4_installed') {
    run.log(`note: P3 recorder cases not run (org plan ${planTier}; start the api with SIGNUP_PLAN_TIER=p3_portable)`);
    return false;
  }
  const native = (name) => open(name, { 'User-Agent': UA });
  const p3 = {};

  await run.step('P3: native Desk on a p3_portable session; recorder.assign carries tier p3_portable; join', async () => {
    await api.expect('PATCH', `/api/v1/users/${userId}/role`, { role: 'org_admin', tier: 'p3_portable' });
    const created = await api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'one_time', label: 'recorder smoke p3' }, [201]);
    p3.compact = created.compact;
    p3.desk = await native('p3-desk');
    p3.desk.send({ t: 'desk.hello', token: created.compact, client: NATIVE });
    await p3.desk.reply('desk.hello.ok', tmo);
    p3.desk.send({ t: 'desk.knock' });
    p3.sessionId = (await p3.desk.reply('knock.ok', tmo)).sessionId;
    await st.assist.next((m) => m.t === 'assist.knock' && m.sessionId === p3.sessionId, tmo, 'assist.knock (p3)');
    st.assist.send({ t: 'assist.accept', sessionId: p3.sessionId });
    eq((await st.assist.reply('session.created', tmo)).tier, 'p3_portable', 'session.created tier');
    await p3.desk.next('session.created', tmo);
    p3.desk.send({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1], clipboard: false } });
    eq((await p3.desk.reply('consent.ok', tmo)).state, 'active', 'consent.ok');
    const a = await st.rec.next((m) => m.t === 'recorder.assign' && m.sessionId === p3.sessionId, tmo, 'recorder.assign (p3)');
    eq(a.tier, 'p3_portable', 'assign tier');
    eq(a.resume, false, 'assign resume');
    st.rec.send({ t: 'recorder.join', sessionId: p3.sessionId });
    await st.rec.reply('recorder.joined', tmo);
    return `session ${p3.sessionId}`;
  });

  await run.step('P3: the native Desk answers the recorder offer (peer: recorder)', async () => {
    st.rec.send({ t: 'webrtc.offer', sessionId: p3.sessionId, sdp: 'v=0\r\no=- smoke-recorder-p3\r\n' });
    eq((await p3.desk.next('webrtc.offer', tmo)).peer, 'recorder', 'offer peer tag');
    p3.desk.send({ t: 'webrtc.answer', sessionId: p3.sessionId, sdp: 'v=0\r\no=- smoke-native\r\n', peer: 'recorder' });
    eq((await st.rec.next('webrtc.answer', tmo)).peer, 'recorder', 'answer peer tag');
  });

  await run.step('P3: hand-over pauses the recorder and re-assigns it (resume); the elevated Desk answers the re-offer', async () => {
    p3.desk.send({ t: 'desk.elevation', sessionId: p3.sessionId, opId: OP });
    const ho = await p3.desk.reply('elevation.handover', tmo);
    const d2 = await native('p3-admin');
    d2.send({ t: 'desk.hello', token: p3.compact, handover: ho.handover, client: ADMIN });
    await d2.reply('desk.hello.ok', tmo);
    eq((await p3.desk.waitClose(tmo)).code, 4411, 'old Desk close code');
    const pause = await st.rec.next((m) => m.t === 'recorder.pause' && m.sessionId === p3.sessionId, tmo, 'recorder.pause');
    eq(pause.reason, 'consent_pending', 'pause reason');
    const again = await st.rec.next((m) => m.t === 'recorder.assign' && m.sessionId === p3.sessionId, tmo, 'recorder.assign (resume)');
    eq(again.resume, true, 're-assign resume');
    st.rec.send({ t: 'recorder.join', sessionId: p3.sessionId });
    eq((await st.rec.reply('recorder.joined', tmo)).resume, true, 'recorder.joined resume');
    st.rec.send({ t: 'webrtc.offer', sessionId: p3.sessionId, sdp: 'v=0\r\no=- smoke-recorder-p3-2\r\n' });
    eq((await d2.next('webrtc.offer', tmo)).peer, 'recorder', 're-offer reaches the elevated Desk');
    d2.send({ t: 'webrtc.answer', sessionId: p3.sessionId, sdp: 'v=0\r\no=- smoke-native-admin\r\n', peer: 'recorder' });
    await st.rec.next('webrtc.answer', tmo);
    p3.desk = d2;
  });

  await run.step('P3: end, server upload, audit holds the recording and elevation.granted in order', async () => {
    p3.desk.send({ t: 'session.end', sessionId: p3.sessionId });
    const ended = await st.rec.next((m) => m.t === 'session.ended' && m.sessionId === p3.sessionId, tmo, 'session.ended (p3)');
    eq(ended.serverRecording, true, 'session.ended.serverRecording');
    const file = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(1024)]);
    const sha256 = createHash('sha256').update(file).digest('hex');
    const form = new FormData();
    form.append('meta', JSON.stringify({ sessionId: p3.sessionId, recorderId: 'smoke-recorder', mime: 'video/webm;codecs="vp8,opus"', durationMs: 900, bytes: file.length, sha256 }));
    form.append('file', new Blob([file], { type: 'video/webm' }), `${p3.sessionId}.webm`);
    const res = await fetch(`${apiUrl}/api/v1/internal/recordings`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'IndiansAssist' }, body: form });
    eq(res.status, 201, 'internal upload status (p3)');
    const a = await api.expect('GET', `/api/v1/sessions/${p3.sessionId}/audit`);
    const names = a.items.map((e) => e.action);
    const i = (n) => names.indexOf(n);
    check(i('recording.server_started') > i('session.started'), 'server_started after session.started');
    check(i('elevation.granted') > i('recording.server_started'), 'elevation.granted during the recording');
    check(i('recording.server_stopped') > i('elevation.granted') && i('recording.server_stopped') < i('session.ended'), 'server_stopped after the hand-over, before session.ended');
    check(i('recording.stored') > i('session.ended'), 'recording.stored');
    eq(a.integrity.ok, true, 'session audit integrity (p3)');
    return `${names.length} entries`;
  });

  await run.step('P3: a native Desk without the recorder feature is never assigned the server recorder', async () => {
    const created = await api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'one_time', label: 'recorder smoke p3 no-flag' }, [201]);
    const desk = await native('p3-desk-norec');
    desk.send({ t: 'desk.hello', token: created.compact, client: NO_RECORDER });
    await desk.reply('desk.hello.ok', tmo);
    desk.send({ t: 'desk.knock' });
    const sessionId = (await desk.reply('knock.ok', tmo)).sessionId;
    await st.assist.next((m) => m.t === 'assist.knock' && m.sessionId === sessionId, tmo, 'assist.knock (p3 no-flag)');
    st.assist.send({ t: 'assist.accept', sessionId });
    await st.assist.reply('session.created', tmo);
    await desk.next('session.created', tmo);
    desk.send({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1], clipboard: false } });
    eq((await desk.reply('consent.ok', tmo)).state, 'active', 'consent.ok (no-flag)');
    check(await absent(st.rec, (m) => m.t === 'recorder.assign' && m.sessionId === sessionId, 800), 'no recorder.assign for a Desk without recorder');
    check(await absent(desk, (m) => m.t === 'session.recording' && m.recording === true, 50), 'no session.recording true on the Desk');
    desk.send({ t: 'session.end', sessionId });
    await st.assist.next((m) => m.t === 'session.ended' && m.sessionId === sessionId, tmo, 'session.ended (p3 no-flag)');
    const names = (await api.expect('GET', `/api/v1/sessions/${sessionId}/audit`)).items.map((e) => e.action);
    check(!names.includes('recording.server_started'), 'no recording.server_started');
    return `session ${sessionId}`;
  });
  return true;
}
