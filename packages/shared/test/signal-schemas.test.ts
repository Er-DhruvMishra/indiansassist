import { describe, expect, it } from 'vitest';
import {
  clientSignalMessageSchema,
  encodeSignal,
  parseClientSignal,
  parseServerSignal,
  parseSignalMessage,
  serverSignalMessageSchema,
  signalMessageSchema,
} from '../src/index.js';

const S = '11111111-2222-4333-8444-555555555555';
const U = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const T = '2026-10-23T10:15:30.123Z';
const ORG = { displayName: 'Acme IT', accentColor: '#0f766e', logoData: null };
const ICE = { iceServers: [{ urls: ['stun:x:3478'] }], iceTtl: 3600, iceExpiresAt: T };
const ref = { id: U, name: 'Priya S' };

/** One example per `t` of the section 7.3 catalogue (client -> server). */
const CLIENT_EXAMPLES = [
  { t: 'desk.knock', id: 'c1', deskLabel: 'Rahul' },
  { t: 'assist.hello' },
  { t: 'desk.hello', token: 'ia1.3f9a1c2b4d5e6f70.eyJ2IjoxfQ.mZ3Q9', deskLabel: 'Rahul', resumeKey: 'abc' },
  { t: 'desk.hello', token: '482193657710' },
  { t: 'desk.poll' },
  { t: 'assist.accept', sessionId: S },
  { t: 'assist.deny', sessionId: S, reason: 'not now', revokeToken: true },
  { t: 'desk.consent', state: 'granted', surface: 'monitor' },
  { t: 'desk.consent', state: 'revoked' },
  { t: 'webrtc.offer', sessionId: S, sdp: 'v=0' },
  { t: 'webrtc.answer', sessionId: S, sdp: 'v=0' },
  {
    t: 'webrtc.ice',
    sessionId: S,
    candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  },
  { t: 'webrtc.ice', sessionId: S, candidate: null },
  { t: 'chat.message', sessionId: S, msgId: U, from: 'desk', text: 'hi', ts: 1761220000000 },
  { t: 'chat.channel_open', sessionId: S },
  {
    t: 'session.stats',
    sessionId: S,
    path: 'relay',
    rttMs: 31.5,
    codec: 'video/VP9',
    bitrateKbps: 900,
    fps: 15,
    width: 1280,
    height: 720,
    packetsLost: 0,
    ts: 1761220000000,
  },
  {
    t: 'desk.event',
    sessionId: S,
    action: 'file.received',
    data: { fileId: 1, direction: 'assist_to_desk', name: 'a.txt', bytes: 5, sha256: 'a'.repeat(64) },
  },
  { t: 'assist.resume', sessionId: S },
  { t: 'session.end', sessionId: S, note: 'done' },
  { t: 'ping' },
  { t: 'pong' },
];

/** One example per `t` sent by the server. */
const SERVER_EXAMPLES = [
  { t: 'assist.hello.ok', connectionId: U, user: { id: U, name: 'Priya S', role: 'technician' }, region: 'in-mum' },
  {
    t: 'desk.hello.ok',
    connectionId: U,
    tokenId: S,
    tier: 'p1_browser',
    technician: { name: 'Priya S' },
    org: ORG,
    region: 'in-mum',
  },
  {
    t: 'desk.hello.ok',
    connectionId: U,
    tokenId: S,
    tier: 'p1_browser',
    technician: null,
    org: ORG,
    region: 'in-mum',
    resume: { sessionId: S, state: 'active', consentState: 'granted' },
  },
  { t: 'poll.status', state: 'waiting', technicianOnline: false },
  { t: 'poll.status', state: 'matched', sessionId: S, sessionState: 'accepted', technicianOnline: true },
  { t: 'knock.ok', sessionId: S, resumeKey: 'k', expiresAt: T },
  { t: 'knock.held', technicianOnline: false },
  { t: 'token.presence', tokenId: S, waiting: true, held: false },
  {
    t: 'assist.knock',
    sessionId: S,
    tokenId: S,
    tokenLabel: null,
    tokenCreatedBy: ref,
    deskLabel: 'Rahul',
    userAgent: 'UA',
    knockedAt: T,
    expiresAt: T,
    canAct: true,
  },
  { t: 'knock.closed', sessionId: S, by: 'accepted', acceptedBy: ref },
  { t: 'knock.closed', sessionId: S, by: 'timeout' },
  {
    t: 'session.created',
    sessionId: S,
    tokenId: S,
    tier: 'p1_browser',
    state: 'consent_pending',
    consentState: 'pending',
    assist: ref,
    desk: { label: 'Rahul' },
    org: ORG,
    polite: true,
    ...ICE,
  },
  {
    t: 'session.created',
    sessionId: S,
    tokenId: S,
    tier: 'p1_browser',
    state: 'consent_pending',
    consentState: 'pending',
    assist: ref,
    desk: { label: 'Rahul' },
    org: ORG,
    polite: false,
  },
  { t: 'consent.ok', sessionId: S, state: 'active', consentState: 'granted', ...ICE },
  { t: 'consent.ok', state: 'ended' },
  { t: 'consent.changed', sessionId: S, state: 'granted', surface: 'window' },
  { t: 'session.recording', sessionId: S, recording: true },
  { t: 'ice.refresh', sessionId: S, ...ICE },
  { t: 'desk.reconnected', sessionId: S, state: 'consent_pending', consentState: 'pending' },
  { t: 'assist.reconnected', sessionId: S, state: 'active', ...ICE },
  {
    t: 'session.ended',
    sessionId: S,
    endReason: 'denied',
    endedAt: T,
    startedAt: null,
    durationMs: null,
    hashChainTail: null,
    assist: ref,
    surface: null,
    recordingStarted: false,
    reachedActive: false,
  },
  {
    t: 'session.ended',
    sessionId: S,
    endReason: 'desk_stopped',
    endedAt: T,
    startedAt: T,
    durationMs: 5000,
    hashChainTail: 'b'.repeat(64),
    assist: ref,
    surface: 'monitor',
    recordingStarted: true,
    reachedActive: true,
  },
  { t: 'event.ok', sessionId: S, entryId: U },
  { t: 'error', re: 'c1', code: 'token_gone', message: 'gone', details: { status: 'expired' } },
  { t: 'error', code: 'region_mismatch', message: 'x', details: { region: 'eu-fra', origin: null } },
  { t: 'webrtc.offer', sessionId: S, sdp: 'v=0' },
  { t: 'chat.message', sessionId: S, msgId: U, from: 'assist', text: 'hello', ts: 1 },
  { t: 'ping' },
];

describe('signaling schemas accept every contract example', () => {
  it.each(CLIENT_EXAMPLES)('client $t', (example) => {
    expect(clientSignalMessageSchema.safeParse(example).success).toBe(true);
    expect(signalMessageSchema.safeParse(example).success).toBe(true);
    const r = parseClientSignal(JSON.stringify(example));
    expect(r.ok).toBe(true);
  });

  it.each(SERVER_EXAMPLES)('server $t', (example) => {
    expect(serverSignalMessageSchema.safeParse(example).success).toBe(true);
    expect(signalMessageSchema.safeParse(example).success).toBe(true);
    expect(parseServerSignal(example).ok).toBe(true);
  });
});

describe('signal parsing', () => {
  it('reports unknown_type with re', () => {
    expect(parseSignalMessage('{"t":"nope","id":"c9"}')).toMatchObject({ ok: false, code: 'unknown_type', re: 'c9' });
    expect(parseClientSignal({ t: 'session.created' })).toMatchObject({ ok: false, code: 'unknown_type' });
    expect(parseServerSignal({ t: 'assist.accept', sessionId: S })).toMatchObject({ ok: false, code: 'unknown_type' });
  });

  it('reports bad_payload for invalid JSON or fields', () => {
    expect(parseSignalMessage('{bad')).toMatchObject({ ok: false, code: 'bad_payload' });
    expect(parseSignalMessage('[]')).toMatchObject({ ok: false, code: 'bad_payload' });
    expect(
      parseClientSignal({ t: 'chat.message', sessionId: S, msgId: U, from: 'desk', text: 'x'.repeat(4001), ts: 1 }),
    ).toMatchObject({ ok: false, code: 'bad_payload' });
    expect(parseClientSignal({ t: 'assist.accept', sessionId: 'not-a-uuid', id: 'c2' })).toMatchObject({
      ok: false,
      code: 'bad_payload',
      re: 'c2',
    });
    expect(
      parseClientSignal({
        t: 'session.stats',
        sessionId: S,
        path: 'p2p',
        rttMs: 1,
        codec: null,
        bitrateKbps: null,
        fps: null,
        width: null,
        height: null,
        packetsLost: null,
        ts: 1.5,
      }),
    ).toMatchObject({ ok: false, code: 'bad_payload' });
  });

  it('reports payload_too_large over 64 KiB', () => {
    const big = JSON.stringify({ t: 'webrtc.offer', sessionId: S, sdp: 'x'.repeat(70000) });
    expect(parseSignalMessage(big)).toMatchObject({ ok: false, code: 'payload_too_large' });
  });

  it('encodeSignal validates', () => {
    expect(JSON.parse(encodeSignal({ t: 'assist.accept', sessionId: S }))).toEqual({
      t: 'assist.accept',
      sessionId: S,
    });
    expect(() => encodeSignal({ t: 'assist.accept', sessionId: 'x' } as never)).toThrow();
  });
});
