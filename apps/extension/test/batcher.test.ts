import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Batcher, type Batch } from '../src/content/batcher';

const inc = (i: number, source = 2) => ({ type: 3, timestamp: i, data: { source, id: i } });
const move = (i: number) => ({ type: 3, timestamp: i, data: { source: 1, positions: [{ x: i, y: i, id: 1, timeOffset: 0 }] } });
const meta = { type: 4, timestamp: 0, data: { href: 'https://example.com/', width: 800, height: 600 } };
const full = { type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } } };

function setup(o = {}) {
  const out: Batch[] = [];
  const need = vi.fn();
  const b = new Batcher((x) => out.push(x), need, o);
  b.setFocused(true);
  return { b, out, need };
}

describe('batcher (section 4.3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes at 64 events', () => {
    const { b, out } = setup();
    for (let i = 0; i < 63; i++) b.push(inc(i));
    expect(out).toHaveLength(0);
    b.push(inc(63));
    expect(out).toHaveLength(1);
    expect(out[0]!.events).toHaveLength(64);
    expect(out[0]!.snapshot).toBe(false);
  });

  it('flushes 200 ms after the first queued event', () => {
    const { b, out } = setup();
    b.push(inc(1));
    vi.advanceTimersByTime(150);
    b.push(inc(2));
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(out).toHaveLength(1);
    expect(out[0]!.events).toHaveLength(2);
  });

  it('a FullSnapshot flushes alone with its preceding Meta as a snapshot frame', () => {
    const { b, out } = setup();
    b.push(inc(1));
    b.push(meta);
    b.push(full);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ events: [inc(1)], snapshot: false });
    expect(out[1]).toEqual({ events: [meta, full], snapshot: true });
  });

  it('splits a queue above 256 KiB of JSON into consecutive batches', () => {
    const { b, out } = setup({ maxEvents: 1000 });
    const big = (i: number) => ({ type: 3, timestamp: i, data: { source: 0, texts: [{ id: i, value: 'x'.repeat(50000) }] } });
    for (let i = 0; i < 12; i++) b.push(big(i));
    b.flush();
    expect(out.length).toBeGreaterThan(1);
    for (const batch of out) expect(JSON.stringify(batch.events).length).toBeLessThanOrEqual(262144);
    expect(out.flatMap((x) => x.events)).toHaveLength(12);
  });

  it('drops a MouseMove when a newer one is queued in the same batch', () => {
    const { b, out } = setup();
    b.push(move(1));
    b.push(inc(2));
    b.push(move(3));
    b.flush();
    expect(out[0]!.events).toEqual([inc(2), move(3)]);
  });

  it('buffers an unfocused tab and flushes on focus; a snapshot is deferred until focus', () => {
    const { b, out } = setup();
    b.setFocused(false);
    b.push(inc(1));
    b.push(inc(2));
    vi.advanceTimersByTime(1000);
    expect(out).toHaveLength(0);
    b.push(meta);
    b.push(full);
    b.push(inc(3));
    expect(out).toHaveLength(0);
    b.setFocused(true);
    expect(out[0]).toEqual({ events: [meta, full], snapshot: true });
    expect(out[1]!.events).toEqual([inc(3)]);
  });

  it('drops the unfocused buffer above its cap and asks for a snapshot on focus', () => {
    const { b, out, need } = setup({ bufferBytes: 1000 });
    b.setFocused(false);
    for (let i = 0; i < 50; i++) b.push(inc(i));
    b.setFocused(true);
    expect(out).toHaveLength(0);
    expect(need).toHaveBeenCalledTimes(1);
  });
});
