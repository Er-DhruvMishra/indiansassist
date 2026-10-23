import { describe, expect, it, vi } from 'vitest';
import { luhnCheckDigit } from '@indiansassist/shared';
import { parseJoinInput, readTokenParam } from '../src/lib/joinInput';
import { buildReceipt, receiptToText } from '../src/lib/receipt';
import { watermarkText, pickRecorderMime } from '../src/lib/recorder';
import { regionDecision, isAllowedOrigin } from '../src/lib/region';
import { SignalClient, backoffDelay } from '../src/lib/signal';
import { computeNetStats, describeRemote } from '../src/lib/stats';
import { contrastRatio, safeAccent } from '../src/lib/contrast';
import { FakeWebSocket, IDS } from './fakes';

const CODE = '48219365771' + String(luhnCheckDigit('48219365771'));

describe('join input', () => {
  it('reads t from the fragment first, then the query', () => {
    expect(readTokenParam('#t=ia1.a.b.c', '?t=other')).toBe('ia1.a.b.c');
    expect(readTokenParam('', '?t=ia1.q')).toBe('ia1.q');
    expect(readTokenParam('', '')).toBeNull();
  });

  it('parses codes, compact tokens and full links', () => {
    expect(parseJoinInput(` ${CODE.slice(0, 4)}-${CODE.slice(4)} `)).toEqual({ kind: 'short_code', value: CODE });
    expect(parseJoinInput('ia1.abc.def .ghi')).toEqual({ kind: 'compact', value: 'ia1.abc.def.ghi' });
    expect(parseJoinInput('https://x.test/join#t=ia1.a.b.c')).toEqual({ kind: 'compact', value: 'ia1.a.b.c' });
    expect(parseJoinInput(`https://x.test/download?t=${CODE}`)).toEqual({ kind: 'short_code', value: CODE });
    expect(parseJoinInput('hello')).toBeNull();
    expect(parseJoinInput('https://x.test/join')).toBeNull();
  });
});

describe('region 421 handling', () => {
  const origins = { 'in-mum': 'https://in.example.com', 'eu-fra': 'https://eu.example.com' } as const;
  it('follows an allow-listed origin that differs from the current one', () => {
    expect(regionDecision({ region: 'eu-fra', origin: 'https://eu.example.com' }, '/join#t=x', 'https://in.example.com', origins, true)).toEqual({
      kind: 'redirect',
      url: 'https://eu.example.com/join#t=x',
    });
  });

  it('never follows an origin outside the allow-list, nor http in production', () => {
    const d = regionDecision({ region: 'eu-fra', origin: 'https://evil.test' }, '/join', 'https://in.example.com', origins, true);
    expect(d).toMatchObject({ kind: 'message', manualOrigin: 'https://evil.test' });
    expect(d.kind === 'message' && d.message).toContain('EU (Frankfurt)');
    expect(isAllowedOrigin('http://in.example.com', { 'in-mum': 'http://in.example.com' }, true)).toBe(false);
    expect(isAllowedOrigin('http://in.example.com', { 'in-mum': 'http://in.example.com' }, false)).toBe(true);
  });

  it('does not loop when the origin is the current one', () => {
    expect(regionDecision({ region: 'in-mum', origin: 'https://in.example.com' }, '/signup', 'https://in.example.com', origins, true).kind).toBe('message');
  });
});

describe('network stats', () => {
  const report = (bytes: number, relay: boolean) => [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042, nominated: true, state: 'succeeded' },
    { id: 'L', type: 'local-candidate', candidateType: relay ? 'relay' : 'srflx', protocol: 'udp', relayProtocol: relay ? 'tls' : undefined },
    { id: 'R', type: 'remote-candidate', candidateType: 'host' },
    { id: 'V', type: 'inbound-rtp', kind: 'video', codecId: 'C', framesPerSecond: 14.6, frameWidth: 1280, frameHeight: 720, packetsLost: 3, bytesReceived: bytes },
    { id: 'C', type: 'codec', mimeType: 'video/VP9' },
  ];

  it('reports path, RTT, codec, resolution and the bitrate delta', () => {
    const first = computeNetStats(report(100000, false), null, 1000);
    expect(first).toMatchObject({ path: 'p2p', rttMs: 42, codec: 'video/VP9', width: 1280, height: 720, fps: 14.6, packetsLost: 3, bitrateKbps: null });
    const second = computeNetStats(report(350000, false), first, 3000);
    expect(second.bitrateKbps).toBe(1000);
  });

  it('detects relay from either candidate and unknown without a pair', () => {
    expect(computeNetStats(report(1, true), null).path).toBe('relay');
    expect(computeNetStats(report(1, true), null).relayProtocol).toBe('tls');
    expect(computeNetStats([{ id: 'x', type: 'inbound-rtp', kind: 'audio' }], null).path).toBe('unknown');
    expect(computeNetStats(new Map(report(1, false).map((s) => [s.id, s])), null).path).toBe('p2p');
  });

  it('describes the remote view for screen readers', () => {
    expect(describeRemote({ width: 1280, height: 720, path: 'relay' }, true)).toBe('Remote screen, 1280 by 720, connected via relay');
    expect(describeRemote({ width: null, height: null, path: 'unknown' }, false)).toBe('Remote screen, not connected');
  });
});

describe('receipt', () => {
  it('builds the D6 receipt and its text form', () => {
    const r = buildReceipt({
      ended: {
        t: 'session.ended',
        sessionId: IDS.session,
        endReason: 'desk_stopped',
        endedAt: '2026-10-23T10:30:00.000Z',
        startedAt: '2026-10-23T10:15:00.000Z',
        durationMs: 900000,
        hashChainTail: 'b'.repeat(64),
        assist: { id: IDS.user, name: 'Anil K' },
        surface: 'monitor',
        recordingStarted: true,
        reachedActive: true,
      },
      org: 'Acme IT',
      region: 'in-mum',
      files: [{ direction: 'received', name: 'fix.ps1', bytes: 2048, sha256: 'c'.repeat(64), reported: true }],
      recordingSeen: false,
      now: new Date('2026-10-23T10:31:00.000Z'),
    });
    expect(r).toMatchObject({ recorded: true, shared: 'Your entire screen', technician: { name: 'Anil K' } });
    const text = receiptToText(r);
    expect(text).toContain('Technician:        Anil K');
    expect(text).toContain('Duration:          15:00');
    expect(text).toContain('Received fix.ps1 (2.0 KiB)');
    expect(text).toContain('India (Mumbai)');
  });
});

describe('recording helpers', () => {
  it('formats the watermark text', () => {
    expect(watermarkText('Anil K', IDS.user, IDS.session, new Date('2026-10-23T09:05:07.000Z'))).toBe('Anil K 22222222 44444444 09:05:07 UTC');
  });
  it('prefers vp9, then vp8, then plain webm', () => {
    expect(pickRecorderMime((m) => m.includes('vp8'))).toBe('video/webm;codecs=vp8,opus');
    expect(pickRecorderMime(() => false)).toBe('video/webm');
  });
});

describe('contrast', () => {
  it('falls back to the default accent when white text would fail AA', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(safeAccent('#ffff00')).toBe('#0f766e');
    expect(safeAccent('#1d4ed8')).toBe('#1d4ed8');
    expect(safeAccent('javascript:alert(1)')).toBe('#0f766e');
  });
});

describe('SignalClient', () => {
  it('answers JSON pings, validates outbound frames and stops on terminal close codes', () => {
    FakeWebSocket.reset();
    const onOpen = vi.fn((c: SignalClient) => c.send({ t: 'assist.hello' }));
    const c = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, onOpen, latencyPingMs: 0 });
    c.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();
    expect(ws.ofType('assist.hello')).toHaveLength(1);
    ws.receive({ t: 'ping' });
    expect(ws.ofType('pong')).toHaveLength(1);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(c.send({ t: 'assist.accept', sessionId: 'nope' } as never)).toBe(false);
    expect(err).toHaveBeenCalled();
    ws.close(4403);
    expect(c.state).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('reconnects with backoff after a non-terminal close and re-sends hello', () => {
    vi.useFakeTimers();
    FakeWebSocket.reset();
    const onOpen = vi.fn((cl: SignalClient) => cl.send({ t: 'assist.hello' }));
    const c = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, onOpen, latencyPingMs: 0 });
    c.connect();
    FakeWebSocket.instances[0]!.open();
    FakeWebSocket.instances[0]!.close(1006);
    expect(c.state).toBe('reconnecting');
    vi.advanceTimersByTime(backoffDelay(0));
    const second = FakeWebSocket.instances[1]!;
    second.open();
    expect(onOpen).toHaveBeenLastCalledWith(c, true);
    expect(second.ofType('assist.hello')).toHaveLength(1);
    c.close();
    vi.useRealTimers();
  });
});
