/**
 * P3 console building blocks: the control.input / text_burst reporter, the text buffer and key routing, the SAS gate,
 * the stats fold and glass-to-glass estimate, the playbook reducers, the mosaic layout, the streaming sha256 sender
 * (hash equals sha256 of the whole, 2 GiB cap, passive-risk refusal, back-pressure) and the family rule.
 */
import { describe, expect, it, vi } from 'vitest';
import { LIMITS, sha256Hex, type AgentStats } from '@indiansassist/shared';
import { InputReporter, TextBuffer, routeKey, wheelNotches, type InputReport } from '../src/assist/console/agent/agentInput';
import { applyEnd, applyOutput, mergeManifest, PLAYBOOK_CHANGED_TEXT, runErrorText } from '../src/assist/console/agent/agentPlaybooks';
import { AGENT_INITIAL, controlBlocker, levelAllows, levelChip } from '../src/assist/console/agent/agentState';
import { foldedStats, glassFromReport } from '../src/assist/console/agent/agentStatsFold';
import { mosaicLayout } from '../src/assist/console/agent/MonitorPicker';
import { SAS_LOCK_MS, SAS_GATE_INITIAL, checkSas } from '../src/assist/console/agent/sasGate';
import { ApiRequestError } from '../src/lib/api';
import { ChannelHub } from '../src/lib/channels';
import { FileTransfer } from '../src/lib/fileTransfer';
import { NATIVE_SEND_OPTIONS, refuseForNativeDesk, streamSha256 } from '../src/lib/streamingFile';

describe('InputReporter (section 3.8)', () => {
  it('aggregates per monitor over 10 s with textChars, and reports one text burst above 200 chars', () => {
    let now = 1000;
    const out: InputReport[] = [];
    const r = new InputReporter((x) => out.push(x), () => 1, () => now);
    r.record('os.pointer', { monitorId: 2, kind: 'click' });
    r.record('os.text', { text: 'x'.repeat(150) });
    r.record('os.text', { text: 'y'.repeat(60) });
    r.record('os.key', { kind: 'press' });
    r.record('clipboard.set', { text: 'not counted' });
    expect(out.filter((o) => o.action === 'input.text_burst')).toEqual([{ action: 'input.text_burst', data: { chars: 210, windowMs: 1, monitorId: 2 } }]);
    now += 10_000;
    r.flush(false);
    const ci = out.find((o) => o.action === 'control.input')!;
    expect(ci.data).toEqual({ mode: 'os', monitorId: 2, count: 4, kinds: ['pointer', 'text', 'key'], windowMs: 10_000, textChars: 210 });
  });
  it('without a recent pointer the viewed monitor is used', () => {
    const out: InputReport[] = [];
    const r = new InputReporter((x) => out.push(x), () => 3, () => 5);
    r.record('os.nav', { action: 'back' });
    r.flush(true);
    expect(out[0]!.data['monitorId']).toBe(3);
  });
});

describe('text buffer and key routing (section 5.2)', () => {
  it('flushes at 32 chars or after 50 ms', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const b = new TextBuffer((t) => sent.push(t));
    b.push('a'.repeat(31));
    expect(sent).toEqual([]);
    b.push('b');
    expect(sent).toEqual(['a'.repeat(31) + 'b']);
    b.push('hi');
    vi.advanceTimersByTime(50);
    expect(sent[1]).toBe('hi');
    vi.useRealTimers();
  });
  it('named keys, chords and numpad go to os.key; printable characters are text', () => {
    const k = (key: string, code = 'KeyA', mods = {}) => routeKey({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(k('Enter', 'Enter')).toBe('key');
    expect(k('a', 'KeyA', { ctrlKey: true })).toBe('key');
    expect(k('5', 'Numpad5')).toBe('key');
    expect(k('a')).toBe('text');
    expect(k('é', 'KeyE')).toBe('text');
    expect(wheelNotches(250, 0)).toBe(3);
    expect(wheelNotches(-3, 1)).toBe(-3);
    expect(wheelNotches(10000, 0)).toBe(20);
  });
});

describe('SAS gate (section 1.3 step 7)', () => {
  it('three wrong codes lock for 10 s, then it re-arms', () => {
    let s = SAS_GATE_INITIAL;
    for (let i = 0; i < 2; i++) {
      const r = checkSas(s, '000000', '483920', 0);
      expect(r.result).toBe('wrong');
      s = r.state;
    }
    const third = checkSas(s, '000000', '483920', 0);
    expect(third.result).toBe('locked');
    expect(checkSas(third.state, '483920', '483920', SAS_LOCK_MS - 1).result).toBe('locked');
    expect(checkSas(third.state, '483 920', '483920', SAS_LOCK_MS).result).toBe('ok');
  });
});

describe('family rule and chips', () => {
  it('a P2 tier or a P2 level never passes the P3 compare', () => {
    expect(levelAllows('p3_portable', 'control', 'control')).toBe(true);
    expect(levelAllows('p3_portable', 'in_page', 'control')).toBe(false);
    expect(levelAllows('p2_extension', 'control', 'control')).toBe(false);
    expect(levelChip({ consent: { level: 'control', monitors: 1, clipboard: false }, agentLevel: { level: 'control', clipboard: false, elevation: 'admin' } })).toBe('Elevated process (control)');
    expect(controlBlocker({ ...AGENT_INITIAL })).toBe('Securing the connection');
  });
  it('a Desk without the input feature (a Wayland Linux Desk) cannot be switched to Control', () => {
    const sec = { state: 'established' as const, gen: 1, sas: '1234', failReason: null };
    const caps = { monitors: 1, elevation: 'user' as const, features: ['chat', 'files'] as const, encoders: [], hwEncoder: false, interpreters: [] };
    expect(controlBlocker({ ...AGENT_INITIAL, sec, capabilities: { ...caps, features: [...caps.features] } })).toBe('This Desk cannot take remote control');
    expect(controlBlocker({ ...AGENT_INITIAL, sec, capabilities: { ...caps, features: ['screen', 'input'] } })).not.toBe('This Desk cannot take remote control');
  });
});

describe('stats fold (section 4.4)', () => {
  it('glassMs = rtt/2 + encode + jitter buffer + decode', () => {
    const report = [{ type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 2, jitterBufferEmittedCount: 100, totalDecodeTime: 0.5, framesDecoded: 100 }];
    expect(glassFromReport(report, 40, 10)).toBe(20 + 10 + 20 + 5);
    expect(glassFromReport(report, null, 10)).toBeNull();
    const stats = { t: 'agent.stats', encoder: 'vp8', hwEncoder: false, capturePath: 'gdi', rung: 'floor', floorMode: true, targetKbps: 250, sentKbps: 240, recorderKbps: null, captureFps: 5, sentFps: 5, encodeMs: 4, monitors: [{ id: 1, width: 1, height: 1, fps: 5 }, { id: 2, width: 1, height: 1, fps: 0 }], cpuPercent: null, ts: 1 } satisfies AgentStats;
    expect(foldedStats(stats, 55)).toMatchObject({ encoder: 'vp8', floorMode: true, capturePath: 'gdi', monitorsStreaming: 1, encodeMs: 4, glassMs: 55 });
  });
});

describe('playbook reducers', () => {
  it('appends output per stream and ends; merges REST entries; explains 409 playbook_changed', () => {
    const run = { runId: 'r', playbookId: 'p', name: 'n', stdout: '', stderr: '', end: null, opError: null };
    let runs = applyOutput([run], { t: 'pb.output', runId: 'r', stream: 'stderr', seq: 0, chunk: 'oops', ts: 1 });
    runs = applyEnd(runs, { t: 'pb.end', runId: 'r', exit: 1, durationMs: 3, truncated: false, ranAs: 'admin', ts: 2 });
    expect(runs[0]).toMatchObject({ stderr: 'oops', end: { exit: 1 } });
    expect(runErrorText(new ApiRequestError(409, 'playbook_changed', 'x'))).toBe(PLAYBOOK_CHANGED_TEXT);
    const m = { id: 'a', name: 'A', description: '', interpreter: 'cmd' as const, requiresElevation: false, parameters: [], timeoutSec: 1, bodyHash: 'h' };
    const rest = [{ ...m, id: 'b', enabled: true, createdBy: null, createdAt: '', updatedAt: '' }, { ...m, enabled: true, createdBy: null, createdAt: '', updatedAt: '' }];
    expect(mergeManifest([m], rest).map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('mosaic layout follows the virtual-desktop rects', () => {
    const l = mosaicLayout([
      { id: 1, name: '', primary: true, x: 0, y: 0, width: 100, height: 50, scale: 1, mid: null },
      { id: 2, name: '', primary: false, x: 100, y: 0, width: 100, height: 100, scale: 1, mid: null },
    ]);
    expect(l[1]).toEqual({ id: 2, left: 50, top: 0, width: 50, height: 100 });
  });
});

describe('streaming file sender (section 6.1 F2)', () => {
  it('the incremental hash equals sha256 of the whole (stream and slice paths)', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => (i * 31) % 251);
    const blob = new Blob([bytes]);
    const progress: number[] = [];
    expect(await streamSha256(blob, (n) => progress.push(n))).toBe(sha256Hex(bytes));
    expect(progress.at(-1)).toBe(bytes.length);
    const noStream = Object.assign(new Blob([bytes]), { stream: undefined });
    expect(await streamSha256(noStream)).toBe(sha256Hex(bytes));
  });
  it('2 GiB cap and passive-risk refusal for a native Desk', async () => {
    expect(NATIVE_SEND_OPTIONS.maxBytes).toBe(LIMITS.fileMaxBytesNative);
    expect(refuseForNativeDesk('evil.url')).toMatch(/refuses/);
    expect(refuseForNativeDesk('notes.txt')).toBeNull();
    const ft = new FileTransfer(new ChannelHub('desk'), 'assist', () => undefined, async () => true, NATIVE_SEND_OPTIONS);
    await expect(ft.send(new File(['x'], 'evil.library-ms'))).rejects.toThrow(/refuses/);
    const big = { name: 'big.bin', size: LIMITS.fileMaxBytesNative + 1, type: '' } as unknown as File;
    await expect(ft.send(big)).rejects.toThrow(/larger/);
  });
  it('waits on bufferedAmount (back-pressure) and never reads the whole file at once', async () => {
    const hub = new ChannelHub('desk');
    const ch = Object.assign(new EventTarget(), { label: 'ia.file', readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0, binaryType: 'arraybuffer', onmessage: null as ((e: MessageEvent) => void) | null, sent: [] as unknown[], send(d: unknown) { this.sent.push(d); this.bufferedAmount += 600_000; } });
    hub.attach('ia.file', ch as unknown as RTCDataChannel);
    const ft = new FileTransfer(hub, 'assist', () => undefined, async () => true, NATIVE_SEND_OPTIONS);
    const file = new File([new Uint8Array(2 * 1024 * 1024)], 'data.bin');
    const sending = ft.send(file);
    await vi.waitFor(() => expect(ch.sent.length).toBe(1));
    const offer = JSON.parse(ch.sent[0] as string) as { fileId: number; sha256: string };
    expect(offer.sha256).toBe(sha256Hex(new Uint8Array(2 * 1024 * 1024)));
    ch.onmessage!({ data: JSON.stringify({ t: 'file.accept', fileId: offer.fileId, ts: 1 }) } as MessageEvent);
    await new Promise((r) => setTimeout(r, 50));
    // offer + first chunk pushed the buffer above the 1 MiB high-water mark: the sender pauses.
    expect(ch.sent.length).toBe(2);
    ch.send = function (d: unknown) {
      this.sent.push(d);
    };
    ch.bufferedAmount = 0;
    ch.dispatchEvent(new Event('bufferedamountlow'));
    await sending;
    expect(ch.sent.length).toBe(1 + 128 + 1); // the offer, 128 chunks of 16 KiB, file.done
    ft.dispose();
  });
});
