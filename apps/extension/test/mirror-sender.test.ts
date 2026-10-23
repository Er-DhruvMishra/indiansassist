import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, MirrorReassembler, decodeMirrorFrame, inflatePayload, isMirrorMessage, utf8Decode } from '@indiansassist/shared';
import { MirrorSender } from '../src/offscreen/mirror-sender';
import { RelayPacer, fromBase64url, relayParts, type RelayFrame } from '../src/offscreen/relay-pacer';

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  frames: ArrayBuffer[] = [];
  send(b: ArrayBuffer) {
    this.frames.push(b);
  }
}

function sender(ch: FakeChannel | null, relayFrames: RelayFrame[] = [], allowRelay = false) {
  const toTab = vi.fn();
  const tooLarge = vi.fn();
  const relay = new RelayPacer((f) => (relayFrames.push(f), true));
  const s = new MirrorSender({
    channel: () => ch as unknown as RTCDataChannel,
    relayAllowed: () => allowRelay,
    relay,
    maxMessageSize: () => 262144,
    toTab,
    onTooLarge: tooLarge,
    onTransport: vi.fn(),
    stallMs: 50,
  });
  return { s, toTab, tooLarge, relay };
}

const ev = (i: number, extra = '') => ({ type: 3, timestamp: i, data: { source: 0, texts: [], attributes: [], removes: [], adds: [], extra } });
afterEach(() => vi.useRealTimers());

describe('mirror sender (sections 4.3-4.5)', () => {
  it('snapshot seq 0, batches 1, 2 ...; frames reassemble to the sanitised events', async () => {
    const ch = new FakeChannel();
    const { s } = sender(ch);
    await s.ingest(4, [{ type: 4, timestamp: 1, data: { href: 'https://example.com/a?token=x#t=y', width: 800, height: 600 } }], true);
    await s.ingest(4, [ev(2)], false);
    await s.ingest(4, [ev(3, 'x'.repeat(5000))], false);
    const headers = ch.frames.map((f) => decodeMirrorFrame(f)).map((d) => (d.ok ? d.header : null));
    expect(headers.map((h) => [h!.kind, h!.seq])).toEqual([
      ['snapshot', 0],
      ['batch', 1],
      ['batch', 2],
    ]);
    expect(headers[2]!.deflate).toBe(true);
    const r = new MirrorReassembler();
    const msgs = ch.frames.map((f) => r.push(f)).filter(isMirrorMessage);
    const snap = JSON.parse(utf8Decode(msgs[0]!.payload));
    expect(snap[0].data.href).toBe('https://example.com/a');
    const big = JSON.parse(utf8Decode(await inflatePayload(msgs[2]!.payload)));
    expect(big[0].data.extra).toHaveLength(5000);
  });

  it('batches before the first snapshot are dropped (the Assist cannot apply them)', async () => {
    const ch = new FakeChannel();
    const { s } = sender(ch);
    await s.ingest(4, [ev(1)], false);
    expect(ch.frames).toHaveLength(0);
  });

  it('a snapshot over 8 MiB raw marks the tab too_large and stops its recorder', async () => {
    const ch = new FakeChannel();
    const { s, toTab, tooLarge } = sender(ch);
    await s.ingest(9, [{ type: 2, timestamp: 1, data: { node: { type: 3, textContent: 'x'.repeat(LIMITS.mirrorSnapshotMaxRawBytes) } } }], true);
    expect(ch.frames).toHaveLength(0);
    expect(tooLarge).toHaveBeenCalledWith(9, 'dc');
    expect(toTab).toHaveBeenCalledWith(9, { t: 'oc.stop', reason: 'too_large' });
  });

  it('nacks within 2 s of a snapshot coalesce; later ones ask for a snapshot', async () => {
    vi.useFakeTimers({ now: 0 });
    const ch = new FakeChannel();
    const { s, toTab } = sender(ch);
    await s.ingest(4, [{ type: 4, timestamp: 1, data: {} }], true);
    s.nack(4);
    expect(toTab).not.toHaveBeenCalled();
    vi.setSystemTime(2500);
    s.nack(4);
    expect(toTab).toHaveBeenCalledWith(4, { t: 'oc.snapshot' });
  });

  it('a stalled channel (bufferedAmount above 1 MiB for 3 s) drops and re-snapshots', async () => {
    const ch = new FakeChannel();
    const { s } = sender(ch);
    await s.ingest(4, [{ type: 4, timestamp: 1, data: {} }], true);
    ch.bufferedAmount = LIMITS.mirrorDcPauseBytes + 1;
    await s.ingest(4, [ev(2)], false);
    expect(ch.frames).toHaveLength(1);
    await s.ingest(4, [ev(3)], false);
    expect(ch.frames).toHaveLength(1); // awaiting a snapshot: batches dropped
  });

  it('without a channel and with relay allowed, payloads go out as paced relay parts', async () => {
    const relayFrames: RelayFrame[] = [];
    const { s } = sender(null, relayFrames, true);
    await s.ingest(4, [{ type: 4, timestamp: 1, data: { width: 1, height: 1 } }], true);
    expect(relayFrames).toHaveLength(1);
    expect(relayFrames[0]).toMatchObject({ t: 'mirror.relay', tabId: 4, seq: 0, kind: 'snapshot', part: 1, parts: 1 });
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(relayFrames[0]!.data)))[0].type).toBe(4);
  });

  it('inside the relay grace a snapshot waits, and the first channel open asks the tab for it again (4.6)', async () => {
    const relayFrames: RelayFrame[] = [];
    let ch: FakeChannel | null = null;
    const toTab = vi.fn();
    const s = new MirrorSender({
      channel: () => ch as unknown as RTCDataChannel,
      relayAllowed: () => false, // org allows relay, but the 5 s grace has not passed yet
      relay: new RelayPacer((f) => (relayFrames.push(f), true)),
      maxMessageSize: () => 262144,
      toTab,
      onTooLarge: vi.fn(),
      onTransport: vi.fn(),
    });
    await s.ingest(4, [{ type: 4, timestamp: 1, data: { width: 1, height: 1 } }], true);
    expect(relayFrames).toHaveLength(0);
    expect(toTab).not.toHaveBeenCalled();
    ch = new FakeChannel();
    s.channelOpened();
    expect(toTab).toHaveBeenCalledWith(4, { t: 'oc.snapshot' });
    await s.ingest(4, [{ type: 4, timestamp: 2, data: { width: 1, height: 1 } }], true);
    expect(ch.frames).toHaveLength(1);
    toTab.mockClear();
    s.channelOpened(); // nothing is waiting any more: no extra snapshot
    expect(toTab).not.toHaveBeenCalled();
  });
});

describe('relay pacer (section 4.6)', () => {
  it('slices at 40960 chars per part and paces against the 512 KiB / 10 s budget', () => {
    vi.useFakeTimers({ now: 0 });
    const parts = relayParts(new Uint8Array(30720 * 30).fill(7), { tabId: 1, seq: 0, kind: 'snapshot', enc: 'none' })!;
    expect(parts).toHaveLength(30);
    expect(parts.every((p) => p.data.length <= LIMITS.mirrorRelayDataChars)).toBe(true);
    const sent: number[] = [];
    const pacer = new RelayPacer((f) => (sent.push(f.part), true));
    pacer.enqueue(parts);
    expect(sent).toHaveLength(12); // 12 * 40960 = 491520 <= 524288 < 13 * 40960
    expect(pacer.used()).toBeLessThanOrEqual(LIMITS.mirrorRelayBudgetBytes);
    vi.advanceTimersByTime(10010);
    expect(sent).toHaveLength(24);
    vi.advanceTimersByTime(10010);
    expect(sent).toHaveLength(30);
    expect(relayParts(new Uint8Array(30720 * 257), { tabId: 1, seq: 0, kind: 'snapshot', enc: 'none' })).toBeNull();
  });
});
