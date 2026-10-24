/**
 * Mirror receiver and recorder (Phase B 4.3-4.7): fragmented and deflated frames reassemble, the seq rule drops
 * gaps and nacks once, acks follow an applied snapshot, relay parts reassemble; the recorder writes the JSONL
 * header, redacts revealed values and gzips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64urlEncode, deflatePayload, encodeMirrorFrames, utf8Encode } from '@indiansassist/shared';
import { MirrorReceiver, type MirrorAckMsg } from '../src/assist/console/mirror/mirrorReceiver';
import { MirrorRecorder, redact } from '../src/assist/console/mirror/mirrorRecorder';
import { IDS } from './fakes';

const meta = { type: 4, timestamp: 1000, data: { href: 'https://a.example/', width: 1280, height: 800 } };
const full = { type: 2, timestamp: 1001, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } };
const inc = (n: number) => ({ type: 3, timestamp: 1100 + n, data: { source: 1, positions: [{ x: n, y: n, id: 1, timeOffset: 0 }] } });

function frames(kind: 'batch' | 'snapshot', tabId: number, seq: number, events: unknown[], chunkBytes?: number): ArrayBuffer[] {
  const raw = utf8Encode(JSON.stringify(events));
  return encodeMirrorFrames({ kind, tabId, seq, rawLength: raw.length, payload: raw, deflate: false, ...(chunkBytes ? { chunkBytes } : {}) });
}

describe('MirrorReceiver', () => {
  let sent: MirrorAckMsg[];
  let snaps: [number, unknown[]][];
  let batches: [number, number, unknown[]][];
  let now: number;
  let rx: MirrorReceiver;

  beforeEach(() => {
    sent = [];
    snaps = [];
    batches = [];
    now = 10_000;
    rx = new MirrorReceiver({
      onSnapshot: (t, e) => snaps.push([t, e]),
      onEvents: (t, s, e) => batches.push([t, s, e]),
      send: (m) => sent.push(m),
      now: () => now,
    });
  });

  it('reassembles a fragmented snapshot in any order and acks once it is applied', async () => {
    const parts = frames('snapshot', 12, 0, [meta, full], 40);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of [...parts].reverse()) rx.pushBinary(p);
    await rx.drain();
    expect(snaps).toEqual([[12, [meta, full]]]);
    rx.applied(12);
    expect(sent).toEqual([{ t: 'mirror.ack', tabId: 12, seq: 0, ts: now }]);
  });

  it('inflates deflated payloads', async () => {
    const raw = utf8Encode(JSON.stringify([meta, full]));
    const payload = await deflatePayload(raw);
    for (const f of encodeMirrorFrames({ kind: 'snapshot', tabId: 3, seq: 0, rawLength: raw.length, payload, deflate: true })) rx.pushBinary(f);
    await rx.drain();
    expect(snaps).toEqual([[3, [meta, full]]]);
  });

  it('delivers batches in seq order, drops a gap, nacks once per 2 s and ignores batches until the next snapshot', async () => {
    for (const f of frames('snapshot', 1, 0, [meta, full])) rx.pushBinary(f);
    for (const f of frames('batch', 1, 1, [inc(1)])) rx.pushBinary(f);
    for (const f of frames('batch', 1, 3, [inc(3)])) rx.pushBinary(f); // seq 2 lost
    for (const f of frames('batch', 1, 4, [inc(4)])) rx.pushBinary(f);
    await rx.drain();
    expect(batches.map((b) => b[1])).toEqual([1]);
    expect(sent.filter((m) => m.t === 'mirror.nack')).toEqual([{ t: 'mirror.nack', tabId: 1, seq: 3, ts: now }]);
    now += 2500;
    for (const f of frames('batch', 1, 5, [inc(5)])) rx.pushBinary(f);
    await rx.drain();
    expect(sent.filter((m) => m.t === 'mirror.nack')).toHaveLength(2);
    for (const f of frames('snapshot', 1, 0, [meta, full])) rx.pushBinary(f);
    for (const f of frames('batch', 1, 1, [inc(6)])) rx.pushBinary(f);
    await rx.drain();
    expect(batches.map((b) => b[1])).toEqual([1, 1]);
  });

  it('expires an incomplete message after 2 s and nacks it; sends periodic acks', async () => {
    for (const f of frames('snapshot', 2, 0, [meta, full])) rx.pushBinary(f);
    await rx.drain();
    rx.applied(2);
    const [first] = frames('batch', 2, 1, [inc(1), inc(2), inc(3)], 30);
    rx.pushBinary(first!);
    now += 2100;
    rx.tick();
    expect(sent.at(-1)).toEqual({ t: 'mirror.nack', tabId: 2, seq: 1, ts: now });
  });

  it('relay: a snapshot supersedes a partial batch, so it neither expires into a nack nor freezes the view (correctness-F9)', async () => {
    const part = (kind: 'batch' | 'snapshot', seq: number, events: unknown[], n: number, parts: number) => {
      const raw = utf8Encode(JSON.stringify(events));
      const size = Math.ceil(raw.length / parts);
      return { tabId: 4, seq, kind, enc: 'none' as const, part: n, parts, data: base64urlEncode(raw.subarray((n - 1) * size, n * size)) };
    };
    rx.pushRelay(part('snapshot', 0, [meta, full], 1, 1));
    rx.pushRelay(part('batch', 1, [inc(1)], 1, 1));
    rx.pushRelay(part('batch', 2, [inc(2), inc(3)], 1, 2)); // part 2 is dropped by the Desk's snapshot supersession
    const stale = part('snapshot', 0, [meta, full, inc(9)], 1, 3); // an older snapshot whose parts 2-3 were dropped
    rx.pushRelay(stale);
    rx.pushRelay(part('snapshot', 0, [meta, full], 1, 2));
    rx.pushRelay(part('snapshot', 0, [meta, full], 2, 2));
    rx.pushRelay(part('batch', 1, [inc(4)], 1, 1));
    await rx.drain();
    now += 2500;
    rx.tick();
    rx.pushRelay(part('batch', 2, [inc(5)], 1, 1));
    await rx.drain();
    expect(sent.filter((m) => m.t === 'mirror.nack')).toEqual([]);
    expect(snaps).toHaveLength(2);
    expect(batches.map((b) => [b[1], b[2]])).toEqual([
      [1, [inc(1)]],
      [1, [inc(4)]],
      [2, [inc(5)]],
    ]);
  });

  it('reassembles relay parts and hands json relay frames to onJson', async () => {
    const onJson = vi.fn();
    const r = new MirrorReceiver({ onSnapshot: (t, e) => snaps.push([t, e]), onEvents: () => undefined, onJson, send: () => undefined });
    const raw = utf8Encode(JSON.stringify([meta, full]));
    const half = Math.ceil(raw.length / 2);
    r.pushRelay({ tabId: 9, seq: 0, kind: 'snapshot', enc: 'none', part: 2, parts: 2, data: base64urlEncode(raw.subarray(half)) });
    r.pushRelay({ tabId: 9, seq: 0, kind: 'snapshot', enc: 'none', part: 1, parts: 2, data: base64urlEncode(raw.subarray(0, half)) });
    await r.drain();
    expect(snaps).toEqual([[9, [meta, full]]]);
    const tabs = { t: 'mirror.tabs', tabs: [], hiddenCount: 2, activeTabId: null, focusedTabId: null, ts: 1 };
    r.pushRelay({ tabId: 0, seq: 0, kind: 'json', enc: 'none', part: 1, parts: 1, data: base64urlEncode(utf8Encode(JSON.stringify(tabs))) });
    expect(onJson).toHaveBeenCalledWith(tabs);
    expect(r.kbps()).toBeGreaterThan(0);
  });
});

describe('MirrorRecorder', () => {
  let t: number;
  beforeEach(() => {
    t = Date.UTC(2026, 9, 23, 10, 0, 0);
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes the forensic header line, events and metadata in receive order', () => {
    const rec = new MirrorRecorder({ sessionId: IDS.session, assist: { id: IDS.user, name: 'Anil K' }, rrweb: '2.1.7', tabs: [] }, false, () => t);
    rec.event(12, 0, meta);
    rec.meta({ t: 'mirror.tab', state: 'paused' }, 12);
    rec.reconnect();
    const lines = rec.text().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ ia_rrweb: 1, sessionId: IDS.session, assist: { id: IDS.user, name: 'Anil K' }, startedAt: '2026-10-23T10:00:00.000Z', rrweb: '2.1.7', tabs: [] });
    expect(lines[1]).toEqual({ tabId: 12, seq: 0, rx: t, e: meta });
    expect(lines[2]).toEqual({ tabId: 12, meta: { t: 'mirror.tab', state: 'paused' }, rx: t });
    expect(lines[3]).toEqual({ meta: { t: 'reconnect' }, rx: t });
    expect(rec.mime).toBe('application/x-ia-rrweb+jsonl');
  });

  it('redacts input events and mutation texts while a reveal is in force, writing one redacted line', () => {
    const rec = new MirrorRecorder({ sessionId: IDS.session, assist: { id: IDS.user, name: 'A' }, rrweb: '2.1.7', tabs: [] }, false, () => t);
    const input = { type: 3, timestamp: 5, data: { source: 5, id: 8, text: 'secret-value', isChecked: false } };
    const mutation = { type: 3, timestamp: 6, data: { source: 0, texts: [{ id: 9, value: 'revealed text' }], attributes: [], removes: [], adds: [] } };
    rec.revealStart(12, 'tab');
    rec.event(12, 1, input);
    rec.event(12, 2, mutation);
    rec.event(13, 1, input); // another tab is not revealed
    t += 30_000;
    rec.revealEnd(12);
    const text = rec.text();
    expect(text.match(/secret-value/g)).toHaveLength(1);
    expect(text).not.toContain('revealed text');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toEqual({ tabId: 12, redacted: { scope: 'tab', from: t - 30_000, to: t }, rx: t });
    expect(redact({ type: 3, data: { source: 2 } })).toEqual({ type: 3, data: { source: 2 } });
  });

  it('keeps revealed values when policy.recordRevealed is true', () => {
    const rec = new MirrorRecorder({ sessionId: IDS.session, assist: { id: IDS.user, name: 'A' }, rrweb: '2.1.7', tabs: [] }, true, () => t);
    rec.revealStart(1, 'field');
    rec.event(1, 1, { type: 3, timestamp: 5, data: { source: 5, id: 8, text: 'kept' } });
    rec.revealEnd(1);
    expect(rec.text()).toContain('kept');
    expect(rec.text()).not.toContain('redacted');
  });

  it('gzips the JSONL on finish', async () => {
    const rec = new MirrorRecorder({ sessionId: IDS.session, assist: { id: IDS.user, name: 'A' }, rrweb: '2.1.7', tabs: [] }, false, () => t);
    rec.event(1, 0, meta);
    const blob = await rec.finish();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const back = await new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'))).text();
    expect(back).toBe(rec.text());
  });
});
