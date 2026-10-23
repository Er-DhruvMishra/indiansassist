// WebSocket part of the smoke flow (contracts section 7): Assist and Desk clients walk
// hello -> poll (waiting) -> knock -> accept -> poll (matched) -> media gate -> consent -> offer / answer / ice -> end.
// Every server frame that a step consumes is validated against the shared zod union.

import { SignalClient } from './ws-client.mjs';
import { assertServerFrame } from './shared.mjs';
import { HEX64 } from './flow-rest.mjs';
import { check, eq } from './runner.mjs';

const FAKE_OFFER = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n';
const FAKE_ANSWER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

/** @param {import('./runner.mjs').Runner} run */
export async function signalSteps(run, ctx) {
  const { shared, state, cfg } = ctx;
  const T = cfg.timeoutMs;
  const frame = (m, label) => assertServerFrame(shared, m, label);
  const reply = async (client, t) => frame(await client.reply(t, T), `${client.name} ${t}`);

  await run.step('WS assist: upgrade with cookie + assist.hello', async () => {
    const assist = new SignalClient('assist', cfg.signalUrl, { Origin: cfg.webOrigin, Cookie: ctx.api.cookie });
    ctx.sockets.push(assist);
    await assist.open(T);
    state.assist = assist;
    assist.send({ t: 'assist.hello' });
    const ok = await reply(assist, 'assist.hello.ok');
    eq(ok.user.id, state.user.id, 'assist.hello.ok user.id');
    eq(ok.region, state.region, 'assist.hello.ok region');
    return `connection ${ok.connectionId}`;
  });

  await run.step('WS desk: anonymous upgrade + desk.hello { token }', async () => {
    const desk = new SignalClient('desk', state.deskSignalUrl ?? cfg.signalUrl, { Origin: cfg.webOrigin });
    ctx.sockets.push(desk);
    await desk.open(T);
    state.desk = desk;
    desk.send({ t: 'desk.hello', token: state.compact, deskLabel: 'Smoke Desk' });
    const ok = await reply(desk, 'desk.hello.ok');
    eq(ok.tokenId, state.token.id, 'desk.hello.ok tokenId');
    eq(ok.tier, 'p1_browser', 'desk.hello.ok tier');
    eq(ok.technician?.name, state.user.name, 'desk.hello.ok technician.name (compact token)');
    check(ok.resume === undefined, 'desk.hello.ok must not carry resume without a resumeKey');
    return `connection ${ok.connectionId}`;
  });

  await run.step(
    'assist receives token.presence { waiting: true }',
    async () => {
      const p = frame(await state.assist.next('token.presence', T), 'token.presence');
      eq(p.tokenId, state.token.id, 'token.presence tokenId');
      eq(p.waiting, true, 'token.presence waiting');
    },
    { critical: false },
  );

  await run.step('desk.poll -> poll.status waiting (technician online)', async () => {
    state.desk.send({ t: 'desk.poll' });
    const s = await reply(state.desk, 'poll.status');
    eq(s.state, 'waiting', 'poll.status state');
    eq(s.technicianOnline, true, 'poll.status technicianOnline');
  });

  await run.step('desk.knock -> knock.ok + assist.knock', async () => {
    state.desk.send({ t: 'desk.knock', deskLabel: 'Smoke Desk' });
    const ok = await reply(state.desk, 'knock.ok');
    check(typeof ok.resumeKey === 'string' && ok.resumeKey.length >= 32, 'knock.ok resumeKey missing or short');
    const k = frame(
      await state.assist.next((m) => m.t === 'assist.knock' && m.sessionId === ok.sessionId, T, 'assist.knock'),
      'assist.knock',
    );
    eq(k.tokenId, state.token.id, 'assist.knock tokenId');
    eq(k.canAct, true, 'assist.knock canAct');
    eq(k.tokenCreatedBy.id, state.user.id, 'assist.knock tokenCreatedBy.id');
    const ttl = Date.parse(k.expiresAt) - Date.parse(k.knockedAt);
    check(ttl === 120_000, `assist.knock expiresAt - knockedAt = ${ttl} ms, expected 120000`);
    state.sessionId = ok.sessionId;
    return `session ${ok.sessionId}`;
  });

  await run.step('assist.accept -> session.created on both sides', async () => {
    const sid = state.sessionId;
    state.assist.send({ t: 'assist.accept', sessionId: sid });
    const a = await reply(state.assist, 'session.created');
    const d = await reply(state.desk, 'session.created');
    for (const [side, m] of [
      ['assist', a],
      ['desk', d],
    ]) {
      eq(m.sessionId, sid, `${side} session.created sessionId`);
      eq(m.state, 'consent_pending', `${side} session.created state`);
      eq(m.consentState, 'pending', `${side} session.created consentState`);
      eq(m.assist.id, state.user.id, `${side} session.created assist.id (the acceptor)`);
    }
    eq(a.polite, true, 'assist session.created polite');
    eq(d.polite, false, 'desk session.created polite');
    check(
      d.iceServers === undefined && d.iceTtl === undefined,
      'desk session.created must not carry ICE servers (section 6.11)',
    );
    return `assist ICE servers: ${Array.isArray(a.iceServers) ? a.iceServers.length : 'none'}`;
  });

  await run.step(
    'desk.poll -> poll.status matched',
    async () => {
      state.desk.send({ t: 'desk.poll' });
      const s = await reply(state.desk, 'poll.status');
      eq(s.state, 'matched', 'poll.status state');
      eq(s.sessionId, state.sessionId, 'poll.status sessionId');
    },
    { critical: false },
  );

  await run.step('media gate: webrtc.offer before consent -> error consent_required', async () => {
    const id = state.desk.send({ t: 'webrtc.offer', sessionId: state.sessionId, sdp: FAKE_OFFER });
    const e = frame(
      await state.desk.next((m) => m.t === 'error' || m.t === 'webrtc.answer', T, 'error consent_required'),
      'error',
    );
    eq(e.t, 'error', 'reply type');
    eq(e.code, 'consent_required', 'error code');
    if (e.re !== undefined) eq(e.re, id, 'error re');
  });

  await run.step('desk.consent granted -> consent.ok active + consent.changed', async () => {
    check(
      !state.assist.queue.some((m) => m.t === 'webrtc.offer'),
      'the pre-consent offer was relayed to the Assist (hard rule 1)',
    );
    state.desk.send({ t: 'desk.consent', state: 'granted', surface: 'monitor' });
    const ok = await reply(state.desk, 'consent.ok');
    eq(ok.state, 'active', 'consent.ok state');
    check(Array.isArray(ok.iceServers), 'consent.ok must carry the Desk ICE servers when active');
    const c = frame(await state.assist.next('consent.changed', T), 'consent.changed');
    eq(c.sessionId, state.sessionId, 'consent.changed sessionId');
    eq(c.state, 'granted', 'consent.changed state');
  });

  await run.step('webrtc.offer desk -> assist, relayed verbatim', async () => {
    state.desk.send({ t: 'webrtc.offer', sessionId: state.sessionId, sdp: FAKE_OFFER });
    const o = frame(await state.assist.next('webrtc.offer', T), 'webrtc.offer');
    eq(o.sessionId, state.sessionId, 'webrtc.offer sessionId');
    eq(o.sdp, FAKE_OFFER, 'webrtc.offer sdp');
  });

  await run.step('webrtc.answer assist -> desk, relayed verbatim', async () => {
    state.assist.send({ t: 'webrtc.answer', sessionId: state.sessionId, sdp: FAKE_ANSWER });
    const a = frame(await state.desk.next('webrtc.answer', T), 'webrtc.answer');
    eq(a.sdp, FAKE_ANSWER, 'webrtc.answer sdp');
  });

  await run.step(
    'webrtc.ice end-of-candidates both ways',
    async () => {
      state.desk.send({ t: 'webrtc.ice', sessionId: state.sessionId, candidate: null });
      const i1 = frame(await state.assist.next('webrtc.ice', T), 'webrtc.ice (assist)');
      eq(i1.candidate, null, 'assist webrtc.ice candidate');
      state.assist.send({ t: 'webrtc.ice', sessionId: state.sessionId, candidate: null });
      const i2 = frame(await state.desk.next('webrtc.ice', T), 'webrtc.ice (desk)');
      eq(i2.candidate, null, 'desk webrtc.ice candidate');
    },
    { critical: false },
  );

  await run.step('assist session.end -> session.ended on both sides', async () => {
    state.assist.send({ t: 'session.end', sessionId: state.sessionId, note: 'smoke test' });
    const a = frame(await state.assist.next('session.ended', T), 'assist session.ended');
    const d = frame(await state.desk.next('session.ended', T), 'desk session.ended');
    for (const [side, m] of [
      ['assist', a],
      ['desk', d],
    ]) {
      eq(m.sessionId, state.sessionId, `${side} session.ended sessionId`);
      eq(m.endReason, 'assist_ended', `${side} session.ended endReason`);
      eq(m.reachedActive, true, `${side} session.ended reachedActive`);
      eq(m.surface, 'monitor', `${side} session.ended surface`);
      check(HEX64.test(m.hashChainTail ?? ''), `${side} session.ended hashChainTail is not 64 hex`);
    }
    eq(a.hashChainTail, d.hashChainTail, 'hashChainTail on both sides');
    state.hashChainTail = a.hashChainTail;
    return `chain tail ${a.hashChainTail.slice(0, 16)}...`;
  });

  await run.step(
    'desk socket closed with 4410 after session.ended',
    async () => {
      const c = await state.desk.waitClose(T);
      eq(c.code, 4410, 'close code');
    },
    { critical: false },
  );
}
