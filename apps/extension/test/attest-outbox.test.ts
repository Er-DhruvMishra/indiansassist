import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttestOutbox, type OutboxEntry } from '../src/background/attest-outbox';

const SID = '00000000-0000-4000-8000-000000000001';
const tabAction = (i: number) => ({ kind: 'tabs.pin', opId: i.toString(16).padStart(16, '0'), tabId: i, ok: true });

describe('attestation outbox (section 3.7)', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('50 queued entries: at most 15 frames in the first second, all 50 within 10 s, none dropped', () => {
    const frames: { id: string; at: number }[] = [];
    const ob = new AttestOutbox({ send: (f) => (frames.push({ id: f.id, at: Date.now() }), true), persist: () => undefined });
    for (let i = 0; i < 50; i++) expect(ob.enqueue(SID, 'tab.action', tabAction(i))).toBe(true);
    vi.advanceTimersByTime(999);
    expect(frames.filter((f) => f.at < 1000).length).toBeLessThanOrEqual(15);
    vi.advanceTimersByTime(9001);
    expect(frames).toHaveLength(50);
    expect(new Set(frames.map((f) => f.id)).size).toBe(50);
    for (let i = 0; i < frames.length; i++) {
      const inWindow = frames.filter((f) => f.at >= frames[i]!.at && f.at < frames[i]!.at + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(15);
    }
  });

  it('rate_limited re-queues the frame at the head without loss and halves the rate', () => {
    const frames: string[] = [];
    const ob = new AttestOutbox({ send: (f) => (frames.push(f.id), true), persist: () => undefined });
    for (let i = 0; i < 3; i++) ob.enqueue(SID, 'tab.action', tabAction(i));
    vi.advanceTimersByTime(10);
    expect(frames).toEqual(['e0', 'e1', 'e2']);
    ob.ack('e0');
    ob.rateLimited('e1');
    vi.advanceTimersByTime(2000);
    expect(frames.slice(3)).toEqual(['e1']);
    ob.ack('e1');
    ob.ack('e2');
    expect(ob.size).toBe(0);
  });

  it('keeps entries while the socket is down and persists the queue', () => {
    let open = false;
    const saved: OutboxEntry[][] = [];
    const ob = new AttestOutbox({ send: () => open, persist: (e) => void saved.push(e) });
    ob.enqueue(SID, 'mirror.stopped', { reason: 'ended', batches: 1, bytes: 2 });
    vi.advanceTimersByTime(3000);
    expect(ob.size).toBe(1);
    expect(saved.at(-1)).toHaveLength(1);
    open = true;
    ob.resend();
    vi.advanceTimersByTime(100);
    expect(saved.at(-1)).toHaveLength(1);
    ob.ack('e0');
    expect(saved.at(-1)).toHaveLength(0);
  });

  it('refuses invalid data (a wire host key that is not a hostname, a chain-only key)', () => {
    const ob = new AttestOutbox({ send: () => true, persist: () => undefined });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(ob.enqueue(SID, 'tab.action', { ...tabAction(1), host: 'https://example.com/x' })).toBe(false);
    expect(ob.enqueue(SID, 'tab.action', { ...tabAction(1), hostHash: 'a'.repeat(64) })).toBe(false);
    expect(ob.size).toBe(0);
  });

  it('flush resolves once everything sent was acknowledged', async () => {
    const ob = new AttestOutbox({ send: () => true, persist: () => undefined });
    ob.enqueue(SID, 'mirror.stopped', { reason: 'ended', batches: 0, bytes: 0 });
    let done = false;
    void ob.flush(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    ob.ack('e0');
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
  });
});
